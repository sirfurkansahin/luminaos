import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AITokenUsage } from '@luminaos/ai-gateway';
import { CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';
import { QuotaExceededError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F1-T15 PR2 (RED step), ADR-0014 §a — unit/behavior coverage for the NEW
 * `AIUsageService` (`./ai-usage.service.ts`, does NOT exist yet as of this
 * commit): the four methods extracted from `ObjectsService`'s PRIVATE
 * `withWorkspaceAILock` / `assertAITokenQuotaNotExceeded` /
 * `assertAICostBudgetNotExceeded` / `recordAIUsage` (see
 * `apps/server/src/objects/objects.service.ts` lines 1113-1268 on `main`),
 * made PUBLIC and independently injectable.
 *
 * This file is EXPECTED TO FAIL (module-not-found) until `implementer`:
 *   1. Creates `apps/server/src/ai/ai-usage.service.ts` exporting
 *      `AIUsageService` with the exact public contract ADR-0014 §a pins:
 *        class AIUsageService {
 *          constructor(db: Database, eventStore: EventStoreService, projectionRunner: ProjectionRunner);
 *          async withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
 *          async assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void>;
 *          async assertAICostBudgetNotExceeded(workspaceId: string): Promise<void>;
 *          async recordAIUsage(
 *            workspaceId: string,
 *            fieldDefinitionId: string | undefined,
 *            objectId: string | undefined,
 *            usage: AITokenUsage,
 *            model: string,
 *          ): Promise<void>;
 *        }
 *   2. Makes `ai_usage_records.field_definition_id`/`object_id`
 *      (`apps/server/src/db/schema/ai-usage.ts`) nullable, with a paired
 *      migration/down-script (ADR-0014 §b) whose down-script does NOT try to
 *      re-impose `NOT NULL`.
 *   3. Switches `AIUsageProjection.apply()`
 *      (`apps/server/src/ai/ai-usage.projection.ts`) from
 *      `requireStringPayloadField` to `optionalStringPayloadField` for
 *      `fieldDefinitionId`/`objectId`.
 *
 * Does NOT re-prove the real-Postgres-concurrency lock race (already covered
 * end-to-end by `../objects/object-ai-refresh.integration.test.ts`'s "two
 * CONCURRENT refresh operations" test, which this refactor must leave
 * UNCHANGED and passing) -- this file's own lock tests are a focused,
 * lightweight proof that `withWorkspaceAILock` still (a) serializes same-
 * workspace calls and (b) always unlocks, even when `fn` throws (per
 * ADR-0014 §a's own explicit callout: "kilit içinde `fn` fırlatırsa
 * unlock'un yine de çalışması").
 *
 * The `SUM(...)` quota queries genuinely need a real Postgres to execute
 * meaningfully, so this is a `.integration.test.ts` (Testcontainers), not a
 * mocked unit test -- mirrors `../ai/ai-usage.projection.integration.test.ts`'s
 * exact lightweight harness (no full Nest app boot, direct
 * `new EventStoreService(db)` / `new ProjectionRunner(db, eventStore)`).
 *
 * `AIUsageService` reads `env.aiTokenQuotaPerWorkspace` /
 * `env.aiCostBudgetUsdPerWorkspace` (`../config/env.js`'s eagerly-evaluated
 * singleton) -- so, mirroring `../objects/object-ai-refresh.integration.test.ts`'s
 * and `../config/env-ai.test.ts`'s own convention, `process.env.*` is set
 * BEFORE `AIUsageService` is (dynamically) imported in `beforeAll`, and this
 * file deliberately has NO top-level static import of `./ai-usage.service.ts`
 * (or anything that would transitively trigger `env.ts` evaluation before
 * that point).
 *
 * A single fixed quota/budget threshold is configured ONCE for the whole
 * file; each threshold test instead varies the seeded `ai_usage_records` SUM
 * (via direct raw-SQL inserts, same convention as
 * `../objects/object-ai-refresh.integration.test.ts`'s `seedPriorUsageCost`),
 * in its own freshly-created workspace -- this avoids needing
 * `vi.resetModules()` + a fresh dynamic import per test just to vary the
 * threshold itself.
 */

const TOKEN_QUOTA_PER_WORKSPACE = 1_000;
const COST_BUDGET_USD_PER_WORKSPACE = 5;

interface RawAIUsageRow {
  field_definition_id: string | null;
  object_id: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: string | null;
}

/**
 * The public contract ADR-0014 §a pins for `AIUsageService`, declared LOCALLY
 * (rather than via a top-level `import type { AIUsageService } from
 * './ai-usage.service.js'`) so this file's dynamic import below (necessarily
 * unresolvable right now -- the module doesn't exist yet, the whole point of
 * this RED commit) degrades to a single, isolated, EXPECTED
 * `import-x/no-unresolved` finding at that one import site, instead of
 * cascading into dozens of `@typescript-eslint/no-unsafe-*` findings across
 * every call site below (which an untyped `any` from an unresolved module
 * would otherwise produce). `service` below is fully, soundly typed against
 * this interface for every actual assertion in this file.
 */
interface AIUsageServiceContract {
  withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
  assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void>;
  assertAICostBudgetNotExceeded(workspaceId: string): Promise<void>;
  recordAIUsage(
    workspaceId: string,
    fieldDefinitionId: string | undefined,
    objectId: string | undefined,
    usage: AITokenUsage,
    model: string,
  ): Promise<void>;
}

type AIUsageServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AIUsageServiceContract;

describe('AIUsageService (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: AIUsageServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://ai-usage-service-test-placeholder:6379';
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = String(TOKEN_QUOTA_PER_WORKSPACE);
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = String(COST_BUDGET_USD_PER_WORKSPACE);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Deliberately unresolvable until `implementer` creates
    // `./ai-usage.service.ts` -- see this file's header and the
    // `AIUsageServiceContract` doc comment above for why the resulting
    // `import-x/no-unresolved` finding is expected and contained to this one
    // line, and does not degrade this file's type safety anywhere else.
    const importedModule: unknown = await import('./ai-usage.service.js');
    const AIUsageServiceCtor = (importedModule as { AIUsageService: AIUsageServiceConstructor })
      .AIUsageService;
    service = new AIUsageServiceCtor(db, eventStore, projectionRunner);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: crypto.randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  /**
   * Inserts an `ai_usage_records` row DIRECTLY via raw SQL (bypassing
   * `recordAIUsage`/the event log entirely), mirroring
   * `../objects/object-ai-refresh.integration.test.ts`'s `seedPriorUsageCost`
   * convention -- lets the quota/budget threshold tests below control the
   * exact SUM `assertAITokenQuotaNotExceeded`/`assertAICostBudgetNotExceeded`
   * read, without needing a real provider call or a passing `recordAIUsage`
   * first (whose own nullable-column behavior is tested separately below).
   */
  async function seedUsageRow(
    workspaceId: string,
    overrides: { inputTokens?: number; outputTokens?: number; costUsd?: string | null },
  ): Promise<void> {
    await db.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        crypto.randomUUID(),
        workspaceId,
        'seed-field-definition-id',
        'seed-object-id',
        overrides.inputTokens ?? 0,
        overrides.outputTokens ?? 0,
        null,
        overrides.costUsd ?? null,
      ],
    );
  }

  async function getLatestRowForWorkspace(workspaceId: string): Promise<RawAIUsageRow | undefined> {
    const result = await db.$client.query<RawAIUsageRow>(
      `select field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd
         from ai_usage_records where workspace_id = $1 order by created_at desc limit 1`,
      [workspaceId],
    );
    return result.rows[0];
  }

  // ---------------------------------------------------------------------
  // assertAITokenQuotaNotExceeded — exact-threshold behavior
  // ---------------------------------------------------------------------

  describe('assertAITokenQuotaNotExceeded', () => {
    it('does not throw when cumulative usage is one token BELOW the quota', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-token-below');
      await seedUsageRow(workspaceId, {
        inputTokens: TOKEN_QUOTA_PER_WORKSPACE - 1,
        outputTokens: 0,
      });

      await expect(service.assertAITokenQuotaNotExceeded(workspaceId)).resolves.toBeUndefined();
    });

    it('throws QuotaExceededError when cumulative usage is EXACTLY AT the quota (>=, not strictly >)', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-token-at');
      await seedUsageRow(workspaceId, { inputTokens: TOKEN_QUOTA_PER_WORKSPACE, outputTokens: 0 });

      await expect(service.assertAITokenQuotaNotExceeded(workspaceId)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
    });

    it('throws QuotaExceededError when cumulative usage is comfortably ABOVE the quota', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-token-above');
      await seedUsageRow(workspaceId, {
        inputTokens: TOKEN_QUOTA_PER_WORKSPACE * 2,
        outputTokens: 0,
      });

      await expect(service.assertAITokenQuotaNotExceeded(workspaceId)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
    });
  });

  // ---------------------------------------------------------------------
  // assertAICostBudgetNotExceeded — exact-threshold behavior
  // ---------------------------------------------------------------------

  describe('assertAICostBudgetNotExceeded', () => {
    it('does not throw when cumulative cost is comfortably BELOW the budget', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-cost-below');
      await seedUsageRow(workspaceId, { costUsd: '4.000000' });

      await expect(service.assertAICostBudgetNotExceeded(workspaceId)).resolves.toBeUndefined();
    });

    it('throws QuotaExceededError when cumulative cost is EXACTLY AT the budget (>=, not strictly >)', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-cost-at');
      await seedUsageRow(workspaceId, {
        costUsd: `${String(COST_BUDGET_USD_PER_WORKSPACE)}.000000`,
      });

      await expect(service.assertAICostBudgetNotExceeded(workspaceId)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
    });

    it('throws QuotaExceededError when cumulative cost is comfortably ABOVE the budget', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-cost-above');
      await seedUsageRow(workspaceId, { costUsd: '20.000000' });

      await expect(service.assertAICostBudgetNotExceeded(workspaceId)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
    });
  });

  // ---------------------------------------------------------------------
  // withWorkspaceAILock — serialization + unlock-on-throw
  // ---------------------------------------------------------------------

  describe('withWorkspaceAILock', () => {
    it("propagates fn's rejection AND still releases the advisory lock (a later call for the same workspace does not hang)", async () => {
      const workspaceId = crypto.randomUUID();
      const boom = new Error('boom: fn failed inside the lock');

      await expect(
        service.withWorkspaceAILock(workspaceId, () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      // If the lock were never released by the failed call above, this
      // second call for the SAME workspaceId would hang forever waiting on
      // `pg_advisory_lock` -- the surrounding test timeout is the tripwire
      // for that failure mode.
      const result = await service.withWorkspaceAILock(workspaceId, () =>
        Promise.resolve('released'),
      );
      expect(result).toBe('released');
    }, 15_000);

    it("two concurrent calls for the SAME workspaceId serialize: the second call's fn body never overlaps the first's", async () => {
      const workspaceId = crypto.randomUUID();
      const events: string[] = [];

      function slowFn(label: string): () => Promise<void> {
        return async () => {
          events.push(`${label}-start`);
          await new Promise((resolve) => {
            setTimeout(resolve, 200);
          });
          events.push(`${label}-end`);
        };
      }

      await Promise.all([
        service.withWorkspaceAILock(workspaceId, slowFn('first')),
        service.withWorkspaceAILock(workspaceId, slowFn('second')),
      ]);

      expect(events).toHaveLength(4);

      const firstStart = events.indexOf('first-start');
      const firstEnd = events.indexOf('first-end');
      const secondStart = events.indexOf('second-start');
      const secondEnd = events.indexOf('second-end');

      // Whichever call actually won the race to acquire the lock, its own
      // start+end pair must be fully adjacent in `events` -- the OTHER
      // call's start index must never fall strictly between them (that
      // would mean both fn bodies ran concurrently, i.e. the lock did not
      // serialize them).
      const firstWon = firstStart < secondStart;
      if (firstWon) {
        expect(secondStart).toBeGreaterThan(firstEnd);
      } else {
        expect(firstStart).toBeGreaterThan(secondEnd);
      }
    }, 15_000);
  });

  // ---------------------------------------------------------------------
  // recordAIUsage
  // ---------------------------------------------------------------------

  describe('recordAIUsage', () => {
    it("called WITH fieldDefinitionId/objectId (backward-compat, today's ai-field-refresh call shape) records a row with those exact values", async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-record-with-context');
      const usage: AITokenUsage = { inputTokens: 42, outputTokens: 8 };

      await service.recordAIUsage(
        workspaceId,
        'field-def-123',
        'object-456',
        usage,
        CLAUDE_SONNET_5,
      );

      const row = await getLatestRowForWorkspace(workspaceId);
      expect(row).toBeDefined();
      expect(row?.field_definition_id).toBe('field-def-123');
      expect(row?.object_id).toBe('object-456');
      expect(row?.input_tokens).toBe(42);
      expect(row?.output_tokens).toBe(8);
      expect(row?.model).toBe(CLAUDE_SONNET_5);
      expect(row?.cost_usd).not.toBeNull();
    });

    it('remains best-effort: an internal failure (simulated projection catchUp rejection) is caught/logged, never propagated', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-record-best-effort');
      const usage: AITokenUsage = { inputTokens: 10, outputTokens: 5 };

      vi.spyOn(projectionRunner, 'catchUp').mockRejectedValueOnce(
        new Error('simulated catchUp failure'),
      );

      await expect(
        service.recordAIUsage(
          workspaceId,
          'field-def-best-effort',
          'object-best-effort',
          usage,
          CLAUDE_SONNET_5,
        ),
      ).resolves.toBeUndefined();
    });

    // ---------------------------------------------------------------------
    // ADR-0014 §a/§b — the whole point of this extraction: a QA-originated
    // usage record has no field/object context at all. Requires BOTH the
    // nullable-column migration (§b) and `AIUsageProjection`'s
    // `optionalStringPayloadField` switch (§a) to actually persist a row
    // (rather than the projection throwing `InvalidObjectStateError`
    // internally, which `recordAIUsage`'s existing try/catch would still
    // swallow -- so the OBSERVABLE proof here is the row's existence, not
    // merely "did not throw").
    // ---------------------------------------------------------------------
    it('called WITHOUT fieldDefinitionId/objectId (QA-style usage) succeeds and persists a row with both columns NULL', async () => {
      const workspaceId = await createWorkspace('ai-usage-svc-record-without-context');
      const usage: AITokenUsage = { inputTokens: 15, outputTokens: 3 };

      await expect(
        service.recordAIUsage(workspaceId, undefined, undefined, usage, CLAUDE_SONNET_5),
      ).resolves.toBeUndefined();

      const row = await getLatestRowForWorkspace(workspaceId);
      expect(row).toBeDefined();
      expect(row?.field_definition_id).toBeNull();
      expect(row?.object_id).toBeNull();
      expect(row?.input_tokens).toBe(15);
      expect(row?.output_tokens).toBe(3);
      expect(row?.model).toBe(CLAUDE_SONNET_5);
      expect(row?.cost_usd).not.toBeNull();
    });
  });
});
