import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';

import {
  createRelation,
  newObjectId,
  removeRelation,
  replayRelation,
} from '@luminaos/core-objects';
import type { Relation, RelationEventDraft, RelationKind } from '@luminaos/core-objects';
import { ConflictError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { RelationsViewProjection } from './relations.projection.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { objectsView } from '../db/schema/objects-view.js';
import { relationsView } from '../db/schema/relations-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const STREAM_TYPE = 'relation';

export interface CreateRelationCommandInput {
  fromId: string;
  toId: string;
  kind: RelationKind;
  causationEventId?: string;
}

/**
 * The response shape of `RelationsService.getRelated` — every `Relation`
 * returned here is implicitly `status: 'active'` (see `toRelation`'s own doc
 * comment: a `RelationRemoved` hard-deletes its `relations_view` row, so
 * there is no "removed but visible" row to filter out at this layer).
 */
export interface RelatedSummary {
  parentChild: { parent: Relation | null; children: Relation[]; childrenCount: number };
  dependency: { blocks: Relation[]; blockedBy: Relation[] };
  reference: Relation[];
}

/**
 * The server-side event-sourced integration for `Relation`
 * (`RelationCreated`/`RelationRemoved`) — mirrors `FieldDefinitionsService`'s
 * exact internal pattern (own `STREAM_TYPE`, a stable projection instance,
 * `wrapDrafts` helper, synchronous `ProjectionRunner.catchUp` after every
 * write for read-your-writes).
 */
@Injectable()
export class RelationsService {
  /**
   * A single, stable `RelationsViewProjection` instance for this service's
   * lifetime — see `ObjectsService.projection`'s doc comment for why
   * (checkpointing is by `projection.name`, not instance identity, but
   * reusing one instance avoids any doubt).
   */
  private readonly projection = new RelationsViewProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async create(
    workspaceId: string,
    actor: Actor,
    input: CreateRelationCommandInput,
  ): Promise<Relation> {
    await this.assertObjectExists(workspaceId, input.fromId);
    await this.assertObjectExists(workspaceId, input.toId);

    const existingRelations = await this.getActiveRelationsOfKind(workspaceId, input.kind);

    const relationId = newObjectId();
    const streamId = randomUUID();

    const drafts = createRelation(
      {
        relationId,
        workspaceId,
        fromId: input.fromId,
        toId: input.toId,
        kind: input.kind,
        ...(input.causationEventId !== undefined
          ? { causationEventId: input.causationEventId }
          : {}),
      },
      existingRelations,
    );

    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, 0, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    // The projection's `RelationCreated` handler uses `onConflictDoNothing`
    // on the partial unique index for `kind === 'parentChild'`, so a
    // concurrent `create()` for a different parentChild relation targeting
    // the identical `toId` never crashes the projection — but it means THIS
    // call's insert may have silently lost that race. Verify our own row
    // actually landed before reporting success; if not, this caller
    // genuinely lost the "at most one active parent" race and must see a
    // conflict, not a false 201. Only `parentChild` has this DB-level
    // invariant — `dependency`/`reference` relations have no equivalent
    // uniqueness rule, so no check is needed for them.
    if (input.kind === 'parentChild') {
      const [ownRow] = await this.db
        .select({ id: relationsView.id })
        .from(relationsView)
        .where(eq(relationsView.id, relationId))
        .limit(1);

      if (!ownRow) {
        throw new ConflictError('this object already has an active parent');
      }
    }

    return replayRelation(appended);
  }

  async remove(workspaceId: string, relationId: string, actor: Actor): Promise<void> {
    const streamId = await this.lookupStreamId(workspaceId, relationId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayRelation(priorEvents);

    const drafts = removeRelation(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);
  }

  /**
   * Groups every relation touching `objectId` (either as `fromId` or
   * `toId`) by kind, per this PR's pinned HTTP contract. `objectId`'s OWN
   * lifecycle is intentionally not checked here (mirrors `ObjectsService.
   * get`'s behavior — only `list` filters by lifecycle); `assertObjectExists`
   * still 404s for an id that never existed or belongs to a different
   * workspace.
   *
   * A relation is SUSPENDED (excluded) when its COUNTERPART object (the
   * other end, not `objectId` itself) currently has `lifecycle: 'deleted'` —
   * enforced by the `ne(objectsView.lifecycle, 'deleted')` join filter below,
   * re-evaluated fresh on every call (no stored/cached suspension state, so a
   * later restore of the counterpart makes the relation reappear
   * automatically).
   */
  async getRelated(workspaceId: string, objectId: string): Promise<RelatedSummary> {
    await this.assertObjectExists(workspaceId, objectId);

    const forwardRows = await this.getRelationsWithActiveCounterpart(
      workspaceId,
      relationsView.fromId,
      objectId,
      relationsView.toId,
    );
    const backwardRows = await this.getRelationsWithActiveCounterpart(
      workspaceId,
      relationsView.toId,
      objectId,
      relationsView.fromId,
    );

    const forward = forwardRows.map((row) => this.toRelation(row));
    const backward = backwardRows.map((row) => this.toRelation(row));

    const children = forward.filter((relation) => relation.kind === 'parentChild');
    const parentCandidates = backward.filter((relation) => relation.kind === 'parentChild');

    const blocks = forward.filter((relation) => relation.kind === 'dependency');
    const blockedBy = backward.filter((relation) => relation.kind === 'dependency');

    const forwardReferences = forward.filter((relation) => relation.kind === 'reference');
    const backwardReferences = backward.filter((relation) => relation.kind === 'reference');
    const reference = this.dedupeById([...forwardReferences, ...backwardReferences]);

    return {
      parentChild: {
        parent: parentCandidates[0] ?? null,
        children,
        childrenCount: children.length,
      },
      dependency: { blocks, blockedBy },
      reference,
    };
  }

  /**
   * Selects `relations_view` rows where `matchedColumn = objectId`, INNER
   * JOINed against `objects_view` on `objects_view.id = counterpartColumn`
   * (the OTHER endpoint of the relation) so that a relation whose
   * counterpart is currently soft-deleted is excluded entirely (spec §3
   * suspension). `relations_view` columns are selected explicitly (rather
   * than `select()`'s default `select *`) since the join would otherwise
   * collide with `objects_view`'s own `id` column.
   *
   * The join condition also ANDs `objects_view.workspace_id = workspaceId`
   * (security review finding, defense-in-depth): this relies on the
   * invariant enforced at `create()` time that a relation's `fromId`/`toId`
   * can never reference an object from a different workspace, but scoping
   * the join independently means a bug or data-integrity slip elsewhere
   * can't leak a cross-workspace counterpart into this result.
   */
  private async getRelationsWithActiveCounterpart(
    workspaceId: string,
    matchedColumn: typeof relationsView.fromId | typeof relationsView.toId,
    objectId: string,
    counterpartColumn: typeof relationsView.fromId | typeof relationsView.toId,
  ): Promise<(typeof relationsView.$inferSelect)[]> {
    return this.db
      .select({
        id: relationsView.id,
        streamId: relationsView.streamId,
        workspaceId: relationsView.workspaceId,
        fromId: relationsView.fromId,
        toId: relationsView.toId,
        kind: relationsView.kind,
        createdAt: relationsView.createdAt,
      })
      .from(relationsView)
      .innerJoin(
        objectsView,
        and(eq(objectsView.id, counterpartColumn), eq(objectsView.workspaceId, workspaceId)),
      )
      .where(
        and(
          eq(relationsView.workspaceId, workspaceId),
          eq(matchedColumn, objectId),
          ne(objectsView.lifecycle, 'deleted'),
        ),
      );
  }

  /**
   * De-duplicates by `id` — a defensive guard for `reference`'s symmetric
   * union (see `getRelated`'s doc comment): in practice a reference relation
   * only ever produces one row across the forward/backward queries, but this
   * keeps the contract precise without relying on that invariant silently.
   */
  private dedupeById(relations: Relation[]): Relation[] {
    const seen = new Set<string>();
    const result: Relation[] = [];

    for (const relation of relations) {
      if (seen.has(relation.id)) {
        continue;
      }
      seen.add(relation.id);
      result.push(relation);
    }

    return result;
  }

  /**
   * `fromId`/`toId` existence + workspace-scope in one lookup, per
   * `ObjectsService.lookupStreamId`'s established pattern — this also closes
   * the cross-workspace leak: an id valid in a different workspace won't
   * match this `workspaceId` filter. Any lifecycle counts (archived/deleted
   * objects can still be related), so `objects_view.lifecycle` is
   * intentionally not filtered here.
   */
  private async assertObjectExists(workspaceId: string, objectId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: objectsView.id })
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }
  }

  /**
   * Every row in `relations_view` is already "active" — a `RelationRemoved`
   * hard-deletes its row (see `RelationsViewProjection`), so there is no
   * status filter to apply at the SQL level. The domain type still requires
   * a `status`, so it is hardcoded to `'active'` here (the column doesn't
   * exist in this projection table).
   */
  private async getActiveRelationsOfKind(
    workspaceId: string,
    kind: RelationKind,
  ): Promise<Relation[]> {
    const rows = await this.db
      .select()
      .from(relationsView)
      .where(and(eq(relationsView.workspaceId, workspaceId), eq(relationsView.kind, kind)));

    return rows.map((row) => this.toRelation(row));
  }

  private async lookupStreamId(workspaceId: string, relationId: string): Promise<string> {
    const [row] = await this.db
      .select({ streamId: relationsView.streamId })
      .from(relationsView)
      .where(and(eq(relationsView.id, relationId), eq(relationsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Relation not found');
    }

    return row.streamId;
  }

  private wrapDrafts(
    drafts: RelationEventDraft[],
    workspaceId: string,
    actor: Actor,
  ): NewDomainEvent[] {
    const occurredAt = new Date();

    return drafts.map((draft) => ({
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: draft.type,
      payload: draft.payload,
      actor,
      occurredAt,
    }));
  }

  private toRelation(row: typeof relationsView.$inferSelect): Relation {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      fromId: row.fromId,
      toId: row.toId,
      kind: row.kind as RelationKind,
      status: 'active',
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    };
  }
}
