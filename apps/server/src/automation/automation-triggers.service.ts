import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';

import { createTrigger, deleteTrigger, replayTrigger, updateTrigger } from '@luminaos/automation';
import type { Trigger, TriggerEventDraft, TriggerSpec } from '@luminaos/automation';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { AutomationTriggersViewProjection } from './automation-triggers.projection.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const STREAM_TYPE = 'trigger';

export interface CreateTriggerCommandInput {
  name: string;
  spec: TriggerSpec;
}

export interface UpdateTriggerCommandInput {
  name?: string;
  spec?: TriggerSpec;
}

/**
 * The server-side event-sourced integration for `Trigger`
 * (`TriggerCreated`/`TriggerUpdated`/`TriggerDeleted`) — mirrors
 * `SavedViewsService`'s exact internal pattern (own `STREAM_TYPE`, a stable
 * projection instance, `wrapDrafts`/`lookupStreamId` private helpers,
 * synchronous `ProjectionRunner.catchUp` after every write for
 * read-your-writes).
 *
 * Per ADR-0032 §h, a trigger is ALWAYS workspace-wide, never personal —
 * unlike `SavedViewsService.assertCanMutate`'s ownership-vs-role branch, this
 * is a single FLAT check: `admin`+ may write, `member`+ may read. This is
 * orthogonal to WHO performed the mutation: every write still records the
 * real caller `Actor` on its event (security-review finding, F2-T15 PR2) —
 * flat RBAC means no ownership-based permission branching, not "nobody's
 * identity is worth recording."
 */
@Injectable()
export class AutomationTriggersService {
  /**
   * A single, stable `AutomationTriggersViewProjection` instance for this
   * service's lifetime — see `SavedViewsService.projection`'s doc comment
   * for why (checkpointing is by `projection.name`, not instance identity,
   * but reusing one instance avoids any doubt).
   */
  private readonly projection = new AutomationTriggersViewProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async create(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: CreateTriggerCommandInput,
  ): Promise<Trigger> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const triggerId = ulid();
    const streamId = randomUUID();

    const drafts = createTrigger({
      triggerId,
      workspaceId,
      name: input.name,
      spec: input.spec,
    });

    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, 0, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replayTrigger(appended);
  }

  async update(
    workspaceId: string,
    triggerId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: UpdateTriggerCommandInput,
  ): Promise<Trigger> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const streamId = await this.lookupStreamId(workspaceId, triggerId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayTrigger(priorEvents);

    const drafts = updateTrigger(state, input);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replayTrigger([...priorEvents, ...appended]);
  }

  async delete(
    workspaceId: string,
    triggerId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<void> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const streamId = await this.lookupStreamId(workspaceId, triggerId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayTrigger(priorEvents);

    const drafts = deleteTrigger(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);
  }

  async list(workspaceId: string, callerRole: MembershipRole): Promise<Trigger[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(automationTriggers)
      .where(
        and(
          eq(automationTriggers.workspaceId, workspaceId),
          eq(automationTriggers.lifecycle, 'active'),
        ),
      );

    return rows.map((row) => this.toTrigger(row));
  }

  /**
   * Scoped by `id` + `workspaceId` only, mirroring
   * `SavedViewsService.lookupStreamId`'s exact contract — a `triggerId` that
   * belongs to a different workspace, or doesn't exist at all, is a 404.
   */
  private async lookupStreamId(workspaceId: string, triggerId: string): Promise<string> {
    const [row] = await this.db
      .select({ streamId: automationTriggers.streamId })
      .from(automationTriggers)
      .where(
        and(eq(automationTriggers.id, triggerId), eq(automationTriggers.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundError('Trigger not found');
    }

    return row.streamId;
  }

  /**
   * Mirrors `SavedViewsService.wrapDrafts` exactly: the real caller `Actor`
   * is recorded on every event for audit-trail purposes, even though
   * triggers have no `Actor`-scoped OWNERSHIP (ADR-0032 §h's flat RBAC) —
   * those are orthogonal concerns.
   */
  private wrapDrafts(
    drafts: TriggerEventDraft[],
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

  private toTrigger(row: typeof automationTriggers.$inferSelect): Trigger {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      kind: row.kind as Trigger['kind'],
      spec: row.spec as TriggerSpec,
      lastFiredAt: row.lastFiredAt,
      lifecycle: row.lifecycle as Trigger['lifecycle'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
