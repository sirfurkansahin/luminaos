import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';

import { runInAgentSandbox } from '@luminaos/agent-runtime';
import type { AgentActionResult } from '@luminaos/agent-runtime';
import { QuotaExceededError } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { AgentActionExecutionsProjection } from './agent-action-executions.projection.js';
import { AgentConcurrencyGuard } from './agent-concurrency-guard.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agentActionExecutions } from '../db/schema/agent-action-executions.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/** The dedicated event-stream type for `AgentActionExecutionRecorded` events -- one brand-new stream per recorded action, mirroring `AIUsageService`'s `AI_USAGE_STREAM_TYPE` convention (F3-T1 PR3, ADR-0035 Karar g). */
const AGENT_ACTION_EXECUTION_STREAM_TYPE = 'agent-action-execution';

/**
 * `AgentResourceLimitsService` (F3-T1 PR3, ADR-0035 Karar g): the agent
 * runtime's resource-limit enforcement -- a DB-backed, advisory-lock
 * protected rate limit (structurally mirroring `AIUsageService`'s
 * quota-check/lock/record shape) composed with the in-memory
 * `AgentConcurrencyGuard`, wired together behind ONE public entry point,
 * `executeAgentAction`, which also drives `runInAgentSandbox`
 * (`@luminaos/agent-runtime`, PR1) so no caller ever sees a raw
 * exception/rejection from a sandboxed agent action.
 */
@Injectable()
export class AgentResourceLimitsService {
  private readonly projection = new AgentActionExecutionsProjection();

  private readonly logger = new Logger(AgentResourceLimitsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly concurrencyGuard: AgentConcurrencyGuard,
  ) {}

  /**
   * The public v0 entry point (ADR-0035 Karar g): acquires a concurrency
   * slot, asserts the DB-backed rate limit (both BEFORE `fn` ever runs),
   * runs `fn` inside `runInAgentSandbox`, records the outcome (best-effort),
   * and always releases the concurrency slot -- regardless of how `fn`
   * (or the rate-limit check) resolved.
   */
  async executeAgentAction<T>(
    workspaceId: string,
    agentIdentifier: string,
    actionType: string,
    fn: () => Promise<T>,
  ): Promise<AgentActionResult<T>> {
    const concurrencyKey = `${workspaceId}:${agentIdentifier}`;

    if (!this.concurrencyGuard.acquire(concurrencyKey)) {
      throw new QuotaExceededError('Agent concurrency limit exceeded for this agent.', {
        workspaceId,
        agentIdentifier,
      });
    }

    try {
      return await this.withAgentResourceLock(workspaceId, agentIdentifier, async () => {
        await this.assertActionRateNotExceeded(workspaceId, agentIdentifier);

        const startedAt = Date.now();
        const result = await runInAgentSandbox(fn, { timeoutMs: env.agentSandboxTimeoutMs });
        const durationMs = Date.now() - startedAt;

        await this.recordAgentAction(
          workspaceId,
          agentIdentifier,
          actionType,
          result.outcome,
          durationMs,
        );

        return result;
      });
    } finally {
      this.concurrencyGuard.release(concurrencyKey);
    }
  }

  /**
   * Serializes the rate-limit check through the final record write per
   * `(workspaceId, agentIdentifier)`, via a Postgres session-level advisory
   * lock (`pg_advisory_lock`/`pg_advisory_unlock`) taken on a dedicated
   * connection checked out from the pool -- mirrors `AIUsageService.
   * withWorkspaceAILock` exactly, but scoped to the PAIR (not just
   * workspace), so two concurrent calls for a DIFFERENT agent in the SAME
   * workspace never contend with each other.
   */
  private async withAgentResourceLock<T>(
    workspaceId: string,
    agentIdentifier: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `${workspaceId}:${agentIdentifier}`;
    const client = await this.db.$client.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey]);

      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockKey]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Throws `QuotaExceededError` if this `(workspaceId, agentIdentifier)`
   * pair already has `env.agentActionRateLimitPerWindow` or more
   * `agent_action_executions` rows within the trailing
   * `env.agentActionRateLimitWindowMs` window.
   */
  async assertActionRateNotExceeded(workspaceId: string, agentIdentifier: string): Promise<void> {
    const windowStart = new Date(Date.now() - env.agentActionRateLimitWindowMs);

    const [row] = await this.db
      .select({ total: sql<string>`COUNT(*)` })
      .from(agentActionExecutions)
      .where(
        and(
          eq(agentActionExecutions.workspaceId, workspaceId),
          eq(agentActionExecutions.agentIdentifier, agentIdentifier),
          gte(agentActionExecutions.occurredAt, windowStart),
        ),
      );

    const totalActions = Number(row?.total ?? 0);

    if (totalActions >= env.agentActionRateLimitPerWindow) {
      throw new QuotaExceededError('Agent action rate limit exceeded for this agent.', {
        workspaceId,
        agentIdentifier,
      });
    }
  }

  /**
   * Records one `AgentActionExecutionRecorded` event on its own dedicated
   * stream, then advances `AgentActionExecutionsProjection`. Best-effort,
   * NEVER throws -- mirrors `AIUsageService.recordAIUsage`'s doc comment:
   * this is called AFTER the sandboxed action has already resolved, so a
   * failure here must never discard an already-computed `AgentActionResult`.
   */
  async recordAgentAction(
    workspaceId: string,
    agentIdentifier: string,
    actionType: string,
    outcome: 'success' | 'timeout' | 'failure',
    durationMs: number,
  ): Promise<void> {
    try {
      const streamId = randomUUID();
      const event: NewDomainEvent = {
        id: randomUUID(),
        streamType: AGENT_ACTION_EXECUTION_STREAM_TYPE,
        workspaceId,
        type: 'AgentActionExecutionRecorded',
        payload: {
          workspaceId,
          agentIdentifier,
          actionType,
          outcome,
          durationMs,
        },
        actor: { type: 'agent', id: agentIdentifier },
        occurredAt: new Date(),
      };

      await this.eventStore.append(streamId, 0, [event]);
      await this.projectionRunner.catchUp(this.projection);
    } catch (error) {
      this.logger.error(
        `Agent action execution recording failed for agent "${agentIdentifier}" (workspace ${workspaceId}, action "${actionType}"); the action's own result is unaffected.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
