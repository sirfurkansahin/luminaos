import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import {
  createRelation,
  newObjectId,
  removeRelation,
  replayRelation,
} from '@luminaos/core-objects';
import type { Relation, RelationEventDraft, RelationKind } from '@luminaos/core-objects';
import { NotFoundError } from '@luminaos/shared';
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
      },
      existingRelations,
    );

    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, 0, newEvents);

    await this.projectionRunner.catchUp(this.projection);

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
