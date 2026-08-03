import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';

import {
  createSavedView,
  deleteSavedView,
  newObjectId,
  replaySavedView,
  updateSavedView,
} from '@luminaos/core-objects';
import type { SavedView, SavedViewEventDraft, ViewType } from '@luminaos/core-objects';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent, QuerySpec } from '@luminaos/shared';

import { SavedViewsViewProjection } from './saved-views.projection.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { savedViews } from '../db/schema/saved-views.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const STREAM_TYPE = 'saved-view';

export interface CreateSavedViewCommandInput {
  objectType: string;
  name: string;
  icon: string;
  viewType: ViewType;
  querySpec: Omit<QuerySpec, 'cursor' | 'limit'>;
  dateField?: string;
  startField?: string;
  endField?: string;
  shared: boolean;
}

export interface UpdateSavedViewCommandInput {
  name?: string;
  icon?: string;
  querySpec?: Omit<QuerySpec, 'cursor' | 'limit'>;
  dateField?: string;
  startField?: string;
  endField?: string;
}

/**
 * The server-side event-sourced integration for `SavedView`
 * (`SavedViewCreated`/`SavedViewUpdated`/`SavedViewDeleted`) — mirrors
 * `RelationsService`'s/`FieldDefinitionsService`'s exact internal pattern (own
 * `STREAM_TYPE`, a stable projection instance, `wrapDrafts`/`lookupStreamId`
 * private helpers, synchronous `ProjectionRunner.catchUp` after every write
 * for read-your-writes).
 *
 * The ownership-vs-role permission check (the genuinely new thing this
 * service adds) lives HERE, after `replaySavedView`, not in the controller —
 * this closes a TOCTOU window between checking and acting (F1-T9 plan).
 */
@Injectable()
export class SavedViewsService {
  /**
   * A single, stable `SavedViewsViewProjection` instance for this service's
   * lifetime — see `FieldDefinitionsService.projection`'s doc comment for why
   * (checkpointing is by `projection.name`, not instance identity, but
   * reusing one instance avoids any doubt).
   */
  private readonly projection = new SavedViewsViewProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  /**
   * `shared: true` (a workspace-wide view) is admin-gated; `shared: false`
   * (a personal view) is open to any workspace member. The server derives
   * `ownerId` itself from `actor`/`shared` — it is never accepted from the
   * client (see `create-saved-view.schema.ts`'s doc comment).
   */
  async create(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: CreateSavedViewCommandInput,
  ): Promise<SavedView> {
    if (input.shared && !hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const savedViewId = newObjectId();
    const streamId = randomUUID();
    const ownerId = input.shared ? null : actor.id;

    const drafts = createSavedView({
      savedViewId,
      workspaceId,
      objectType: input.objectType,
      name: input.name,
      icon: input.icon,
      viewType: input.viewType,
      querySpec: input.querySpec,
      ...(input.dateField !== undefined ? { dateField: input.dateField } : {}),
      ...(input.startField !== undefined ? { startField: input.startField } : {}),
      ...(input.endField !== undefined ? { endField: input.endField } : {}),
      ownerId,
    });

    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, 0, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replaySavedView(appended);
  }

  async update(
    workspaceId: string,
    savedViewId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: UpdateSavedViewCommandInput,
  ): Promise<SavedView> {
    const streamId = await this.lookupStreamId(workspaceId, savedViewId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replaySavedView(priorEvents);

    this.assertCanMutate(state, actor, callerRole);

    const drafts = updateSavedView(state, input);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replaySavedView([...priorEvents, ...appended]);
  }

  async delete(
    workspaceId: string,
    savedViewId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<void> {
    const streamId = await this.lookupStreamId(workspaceId, savedViewId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replaySavedView(priorEvents);

    this.assertCanMutate(state, actor, callerRole);

    const drafts = deleteSavedView(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);
  }

  /**
   * Returns every ACTIVE saved view for `workspaceId`+`objectType` that is
   * either shared (`owner_id IS NULL`) or owned by `callerId` — the SQL
   * counterpart of spec AC#2 (F1-T9 plan: this visibility filter lives in
   * the service's `WHERE`, not application-level post-filtering).
   */
  async list(workspaceId: string, objectType: string, callerId: string): Promise<SavedView[]> {
    const rows = await this.db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, workspaceId),
          eq(savedViews.objectType, objectType),
          eq(savedViews.lifecycle, 'active'),
          or(isNull(savedViews.ownerId), eq(savedViews.ownerId, callerId)),
        ),
      );

    return rows.map((row) => this.toSavedView(row));
  }

  /**
   * Ownership-or-role permission branch (the genuinely new thing this
   * service adds, no existing precedent to copy): a PERSONAL view
   * (`ownerId !== null`) may ONLY be mutated by its own owner — ANY other
   * caller, including a workspace admin/owner, gets 403 (ownership beats
   * role rank). A SHARED view (`ownerId === null`) may only be mutated by
   * `admin`+ — member/guest get 403.
   */
  private assertCanMutate(state: SavedView, actor: Actor, callerRole: MembershipRole): void {
    if (state.ownerId !== null) {
      if (state.ownerId !== actor.id) {
        throw new ForbiddenError();
      }
      return;
    }

    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }
  }

  /**
   * Scoped by `id` + `workspaceId` only (no `objectType` scoping, mirroring
   * `RelationsService.lookupStreamId`'s pattern exactly — a saved view's
   * URL has no `:objectType` segment, unlike `field_definitions`). A
   * `savedViewId` that belongs to a different workspace, or doesn't exist at
   * all, is a 404.
   */
  private async lookupStreamId(workspaceId: string, savedViewId: string): Promise<string> {
    const [row] = await this.db
      .select({ streamId: savedViews.streamId })
      .from(savedViews)
      .where(and(eq(savedViews.id, savedViewId), eq(savedViews.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Saved view not found');
    }

    return row.streamId;
  }

  private wrapDrafts(
    drafts: SavedViewEventDraft[],
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

  private toSavedView(row: typeof savedViews.$inferSelect): SavedView {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      objectType: row.objectType,
      name: row.name,
      icon: row.icon,
      viewType: row.viewType as ViewType,
      querySpec: row.querySpec as SavedView['querySpec'],
      dateField: row.dateField ?? undefined,
      startField: row.startField ?? undefined,
      endField: row.endField ?? undefined,
      ownerId: row.ownerId,
      lifecycle: row.lifecycle as SavedView['lifecycle'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
