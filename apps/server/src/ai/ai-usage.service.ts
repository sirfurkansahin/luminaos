import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { calculateCostUsd } from '@luminaos/ai-gateway';
import type { AITokenUsage } from '@luminaos/ai-gateway';
import { QuotaExceededError } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { AIUsageProjection } from './ai-usage.projection.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { aiUsageRecords } from '../db/schema/ai-usage.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/** The dedicated event-stream type for `AIUsageRecorded` events — one brand-new stream per usage record, never the object's own stream (F1-T5 PR-C, moved from `ObjectsService` verbatim, ADR-0014 §a). */
const AI_USAGE_STREAM_TYPE = 'ai-usage';

/**
 * The always-and-only actor recorded for a usage record's own
 * `AIUsageRecorded` event (moved verbatim from `ObjectsService`'s own
 * `AI_GATEWAY_ACTOR`, ADR-0014 §a) -- deliberately `'agent'`, not `'system'`:
 * an AI-gateway completion is a real (if automated) agent action.
 */
const AI_GATEWAY_ACTOR = { type: 'agent', id: 'ai-gateway' } as const;

/**
 * `AIUsageService` (F1-T15 PR2, ADR-0014 §a): the workspace-level AI
 * quota-check / concurrency-lock / usage-recording logic extracted verbatim
 * from `ObjectsService`'s four PRIVATE methods
 * (`withWorkspaceAILock`/`assertAITokenQuotaNotExceeded`/
 * `assertAICostBudgetNotExceeded`/`recordAIUsage`) into an independently
 * injectable service, so any future AI-completion call site (F1-T15's QA
 * flow, F1-T16's conversation-command flow) shares the SAME quota/lock/
 * audit-record code path as `ObjectsService`'s ai-field-refresh flow, instead
 * of duplicating or bypassing it.
 *
 * `recordAIUsage`'s `fieldDefinitionId`/`objectId` parameters are the one
 * intentional signature change from the original private methods: both are
 * now optional, since a QA-originated usage record has no field/object
 * context at all (ADR-0014 §a/§b) -- `ai_usage_records.field_definition_id`/
 * `object_id` are nullable columns as of migration
 * `0020_ai_usage_records_nullable_context.sql`.
 */
@Injectable()
export class AIUsageService {
  /** Same "single, stable instance" reasoning as `ObjectsService.aiUsageProjection` had (moved here, ADR-0014 §a). */
  private readonly aiUsageProjection = new AIUsageProjection();

  private readonly logger = new Logger(AIUsageService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  /**
   * Serializes every AI-completion critical section (quota check through the
   * final usage-record write) per WORKSPACE, via a Postgres session-level
   * advisory lock (`pg_advisory_lock`/`pg_advisory_unlock`) taken on a
   * dedicated connection checked out from the pool -- closes a TOCTOU race
   * where two concurrent calls could both read the same pre-call cumulative
   * usage total and both proceed, letting a workspace's actual spend
   * silently exceed `env.aiTokenQuotaPerWorkspace` (security review finding,
   * F1-T5 PR-C; see `../objects/object-ai-refresh.integration.test.ts`'s
   * "two CONCURRENT refresh operations" test). `hashtext(workspaceId)`
   * scopes the lock per workspace, so concurrent calls in DIFFERENT
   * workspaces never contend with each other. The lock is held across the
   * real `AIProvider.complete()` call(s) -- an accepted v0 tradeoff (these
   * are not a hot path: manual or debounced) in exchange for a simple,
   * well-understood correctness guarantee, instead of holding a DB
   * transaction open across an external HTTP call.
   */
  async withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.db.$client.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [workspaceId]);

      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [workspaceId]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Throws `QuotaExceededError` if this workspace's cumulative
   * `ai_usage_records` usage (`SUM(inputTokens + outputTokens)`) already
   * meets or exceeds `env.aiTokenQuotaPerWorkspace` -- checked BEFORE any
   * provider call, per the caller's own "once per operation" design
   * decision.
   */
  async assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void> {
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${aiUsageRecords.inputTokens} + ${aiUsageRecords.outputTokens}), 0)`,
      })
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.workspaceId, workspaceId));

    const totalTokensUsed = Number(row?.total ?? 0);

    if (totalTokensUsed >= env.aiTokenQuotaPerWorkspace) {
      throw new QuotaExceededError('AI token quota exceeded for this workspace.', { workspaceId });
    }
  }

  /**
   * Throws `QuotaExceededError` if this workspace's cumulative
   * `ai_usage_records` recorded cost (`SUM(cost_usd)`, in USD) already meets
   * or exceeds `env.aiCostBudgetUsdPerWorkspace` -- checked BEFORE any
   * provider call, alongside `assertAITokenQuotaNotExceeded` (F1-T14 PR4).
   * `cost_usd` is a nullable numeric column (older pre-cost-tracking rows,
   * and any future gaps, have `NULL`), so `COALESCE(..., 0)` treats those as
   * $0 rather than breaking the aggregate.
   */
  async assertAICostBudgetNotExceeded(workspaceId: string): Promise<void> {
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${aiUsageRecords.costUsd}), 0)`,
      })
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.workspaceId, workspaceId));

    const totalCostUsed = Number(row?.total ?? 0);

    if (totalCostUsed >= env.aiCostBudgetUsdPerWorkspace) {
      throw new QuotaExceededError('AI cost budget exceeded for this workspace.', { workspaceId });
    }
  }

  /**
   * Records `usage` as an `AIUsageRecorded` event on its OWN dedicated
   * stream (own atomic `append`, separate from the object's own stream --
   * see `AI_USAGE_STREAM_TYPE`'s doc comment), then advances
   * `AIUsageProjection`. Best-effort, never throws -- this is called AFTER
   * an AI provider has already returned a result, so a failure here must
   * never discard an already-generated value.
   *
   * `fieldDefinitionId`/`objectId` are optional (ADR-0014 §a/§b): a
   * QA-originated (or, in the future, conversation-command-originated) usage
   * record has no field/object context at all, and both are omitted from the
   * event payload entirely (rather than persisted as e.g. an empty string)
   * when `undefined`, mirroring this codebase's existing conditional-spread
   * convention for optional fields.
   */
  async recordAIUsage(
    workspaceId: string,
    fieldDefinitionId: string | undefined,
    objectId: string | undefined,
    usage: AITokenUsage,
    model: string,
  ): Promise<void> {
    try {
      const usageStreamId = randomUUID();
      const costUsd = calculateCostUsd(model, usage);
      const event: NewDomainEvent = {
        id: randomUUID(),
        streamType: AI_USAGE_STREAM_TYPE,
        workspaceId,
        type: 'AIUsageRecorded',
        payload: {
          workspaceId,
          ...(fieldDefinitionId !== undefined ? { fieldDefinitionId } : {}),
          ...(objectId !== undefined ? { objectId } : {}),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          model,
          costUsd,
        },
        actor: AI_GATEWAY_ACTOR,
        occurredAt: new Date(),
      };

      await this.eventStore.append(usageStreamId, 0, [event]);
      await this.projectionRunner.catchUp(this.aiUsageProjection);
    } catch (error) {
      this.logger.error(
        `AI usage recording failed for field ${fieldDefinitionId ?? '(none)'} on object ${objectId ?? '(none)'} (workspace ${workspaceId}); the AI value itself already succeeded.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
