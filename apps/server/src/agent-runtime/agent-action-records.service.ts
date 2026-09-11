import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { agentActionRecordedPayloadSchema } from '@luminaos/agent-runtime';
import type {
  ActionResourceReference,
  AgentActionOutcome,
  ActionProvenance,
  AgentActionRecord,
  RollbackPlan,
} from '@luminaos/agent-runtime';
import { ForbiddenError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { AgentActionRecordProjection } from './agent-action-records.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agentActionRecords } from '../db/schema/agent-action-records.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const AGENT_ACTION_RECORD_STREAM_TYPE = 'agent-action-record';

export interface RecordAgentActionInput {
  provenance: ActionProvenance;
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: AgentActionOutcome;
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  undoesRecordId: string | null;
}

type AgentActionRecordRow = typeof agentActionRecords.$inferSelect;

function toAgentActionRecord(row: AgentActionRecordRow): AgentActionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provenance: row.provenance as AgentActionRecord['provenance'],
    actor: { type: row.actorType, id: row.actorId } as Actor,
    actionType: row.actionType,
    intent: row.intent,
    rationale: row.rationale,
    resources: row.resources as ActionResourceReference[],
    rollbackPlan: row.rollbackPlan as RollbackPlan,
    outcome: row.outcome as AgentActionOutcome,
    resultRef: (row.resultRef ?? null) as ActionResourceReference | null,
    causationEventId: row.causationEventId,
    occurredAt: row.occurredAt,
    undoesRecordId: row.undoesRecordId ?? null,
  };
}

/**
 * F3-T4 (ADR-0038 Karar a/b/c/d/e): `AgentActionRecordsService`, the unified
 * agent-action ledger ("Uçuş Kayıt Cihazı" / Flight Recorder). Structurally
 * mirrors `AgentPermissionManifestsService`'s split (own `Projection`
 * instance, constructor-injected `DATABASE_CONNECTION`/`EventStoreService`/
 * `ProjectionRunner`) — but `record()` follows `AgentResourceLimitsService.
 * recordAgentAction`'s best-effort/never-throws contract instead, since a
 * ledger-write failure must never break the real action it is recording
 * (ADR-0038 Karar c/d). Each call writes its OWN fresh `randomUUID()` stream
 * (an `AgentActionRecord` is an independent, never-updated entry — not a
 * per-key toggle like a permission manifest), mirroring `AgentDirectoryService
 * .register`'s "fresh stream per new entity" convention.
 *
 * `record()` takes no `callerRole` at all — it is never exposed via any HTTP
 * route, called only by trusted server code (`CommandsService`'s `executeXxx`
 * methods, `MentionActionWorker`).
 */
@Injectable()
export class AgentActionRecordsService {
  private readonly projection = new AgentActionRecordProjection();

  private readonly logger = new Logger(AgentActionRecordsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  /**
   * NEVER throws — mirrors `AgentResourceLimitsService.recordAgentAction`'s
   * doc comment: this is called AFTER the real action has already completed
   * (or been rejected/failed), so a failure here must never discard or mask
   * that already-decided outcome.
   */
  async record(workspaceId: string, input: RecordAgentActionInput): Promise<void> {
    try {
      const streamId = randomUUID();

      const payload = agentActionRecordedPayloadSchema.parse({
        provenance: input.provenance,
        actionType: input.actionType,
        intent: input.intent,
        rationale: input.rationale,
        resources: input.resources,
        rollbackPlan: input.rollbackPlan,
        outcome: input.outcome,
        resultRef: input.resultRef,
        causationEventId: input.causationEventId,
        undoesRecordId: input.undoesRecordId,
      });

      const event: NewDomainEvent = {
        id: randomUUID(),
        streamType: AGENT_ACTION_RECORD_STREAM_TYPE,
        workspaceId,
        type: 'AgentActionRecorded',
        payload,
        actor: input.actor,
        occurredAt: new Date(),
      };

      await this.eventStore.append(streamId, 0, [event]);
      await this.projectionRunner.catchUp(this.projection);
    } catch (error) {
      this.logger.error(
        `Agent action record write failed for workspace ${workspaceId}, action "${input.actionType}"; the action's own result is unaffected.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * ALL rows for `workspaceId`, workspace-wide — NO personal restriction
   * (ADR-0038 Karar e: this is an audit ledger, not a personal DM thread).
   */
  async list(workspaceId: string, callerRole: MembershipRole): Promise<AgentActionRecord[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(agentActionRecords)
      .where(eq(agentActionRecords.workspaceId, workspaceId));

    return rows.map(toAgentActionRecord);
  }

  /**
   * Scoped by `id` + `workspaceId` together (mirrors `AgentDirectoryService.
   * getById`'s exact contract) — returns `null` (not a thrown `NotFoundError`)
   * for a non-existent id OR one belonging to a different workspace; the
   * controller layer maps `null` to a 404.
   */
  async get(
    workspaceId: string,
    recordId: string,
    callerRole: MembershipRole,
  ): Promise<AgentActionRecord | null> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const [row] = await this.db
      .select()
      .from(agentActionRecords)
      .where(
        and(eq(agentActionRecords.id, recordId), eq(agentActionRecords.workspaceId, workspaceId)),
      )
      .limit(1);

    return row ? toAgentActionRecord(row) : null;
  }

  /**
   * Internal-only (no `callerRole`, never HTTP-exposed directly) -- mirrors
   * `record()`'s own no-RBAC convention. Finds the (at most one) ledger row
   * that undoes `originalRecordId`, if any -- used by `CommandsService.
   * undoAction` (PR2) as a pre-check for a friendly `ConflictError` UX
   * message on a double-undo attempt; the REAL concurrency guarantee is
   * inherited from `ObjectsService.softDelete`'s own optimistic-concurrency
   * (ADR-0040 Karar f), NOT from this lookup.
   */
  async findUndoRecord(
    workspaceId: string,
    originalRecordId: string,
  ): Promise<AgentActionRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentActionRecords)
      .where(
        and(
          eq(agentActionRecords.workspaceId, workspaceId),
          eq(agentActionRecords.undoesRecordId, originalRecordId),
        ),
      )
      .limit(1);

    return row ? toAgentActionRecord(row) : null;
  }
}
