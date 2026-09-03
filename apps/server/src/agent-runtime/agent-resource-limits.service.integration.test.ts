import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { QuotaExceededError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F3-T1 PR3 (RED step), ADR-0035 Karar (g) — `AgentResourceLimitsService`:
 * the DB-backed half of resource limits (rate limiting, per Karar g's
 * split), wired together with the in-memory `AgentConcurrencyGuard`
 * (`./agent-concurrency-guard.ts`, also RED as of this commit -- see
 * `./agent-concurrency-guard.test.ts`) behind ONE public entry point,
 * `executeAgentAction`, which also drives `runInAgentSandbox`
 * (`@luminaos/agent-runtime`, PR1, already merged) and records an
 * insert-only audit-ledger row into the NEW `agent_action_executions` table
 * (schema/migration also not yet on disk as of this commit).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NEITHER `./agent-resource-limits.service.ts`
 * NOR `./agent-concurrency-guard.ts` exists yet, so the dynamic
 * `import('./agent-resource-limits.service.js')` / `import('./agent-
 * concurrency-guard.js')` calls inside `beforeAll` REJECT ("Cannot find
 * module"), failing every `it` in this file -- mirrors `agent-permission-
 * manifests.service.integration.test.ts`'s and `ai-usage.service.
 * integration.test.ts`'s own documented "service doesn't exist yet" red
 * state. Even once those two modules exist, `agent_action_executions`
 * (schema + migration `0038_*`, ALSO not yet on disk) is independently
 * missing -- any query against it fails with a Postgres "relation
 * \"agent_action_executions\" does not exist" error, a second, equally
 * expected RED failure mode this file's tests will hit until the migration
 * lands. Neither failure mode is a bug in this test file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) -- same
 * lightweight harness shape as `agent-permission-manifests.service.
 * integration.test.ts` (direct `new EventStoreService(db)` / `new
 * ProjectionRunner(db, eventStore)`, no full Nest app boot). `env.ts`'s
 * SINGLETON export IS a transitive dependency here (`AgentResourceLimitsService`
 * reads `env.agentSandboxTimeoutMs`/`env.agentActionRateLimitPerWindow`/
 * `env.agentActionRateLimitWindowMs`, per this PR's contract), so -- mirroring
 * `ai-usage.service.integration.test.ts`'s exact convention -- every relevant
 * `process.env.*` value is set BEFORE the dynamic import in `beforeAll`, and
 * this file has NO top-level static import of anything that would
 * transitively trigger `env.ts` evaluation earlier.
 *
 * `AGENT_SANDBOX_TIMEOUT_MS` is set to a short-but-safe `150` (ms) for the
 * WHOLE FILE (not per-test) -- every "fn resolves/rejects quickly" test below
 * settles in a handful of real milliseconds, comfortably under 150ms, so a
 * single shared short timeout serves both the success/failure tests AND the
 * dedicated timeout test (whose never-resolving `fn` only needs to wait
 * ~150ms for `runInAgentSandbox` to race it out), without needing a
 * `vi.resetModules()` + fresh re-import dance per test the way
 * `../config/env-*.test.ts` files do for pinning MULTIPLE distinct values of
 * the SAME var in one file.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `AgentConcurrencyGuard(maxConcurrentPerAgent: number)`:
 *   - `acquire(key: string): boolean` / `release(key: string): void` -- see
 *     `./agent-concurrency-guard.test.ts` for the full contract this file
 *     does not re-prove.
 *
 * `AgentResourceLimitsService(db, eventStore, projectionRunner,
 * concurrencyGuard)` (constructor injection; `concurrencyGuard` is INJECTED,
 * not constructed internally, so this file constructs its OWN instance with a
 * small, test-controlled `maxConcurrentPerAgent`):
 *   - `assertActionRateNotExceeded(workspaceId, agentIdentifier): Promise<void>`
 *     -- counts `agent_action_executions` rows matching
 *     `(workspaceId, agentIdentifier)` with `occurredAt >= now -
 *     env.agentActionRateLimitWindowMs`; throws `QuotaExceededError` if that
 *     count is `>= env.agentActionRateLimitPerWindow`. Runs inside the SAME
 *     Postgres-advisory-lock critical section as `AIUsageService`'s pattern
 *     (`withAgentResourceLock(workspaceId, agentIdentifier, fn)`, lock key
 *     derived from `${workspaceId}:${agentIdentifier}` via `hashtext`) --
 *     this file's own race-safety test below independently verifies that.
 *   - `recordAgentAction(workspaceId, agentIdentifier, actionType, outcome,
 *     durationMs): Promise<void>` -- best-effort, NEVER throws (own try/catch,
 *     logged on failure, mirrors `AIUsageService.recordAIUsage`'s doc
 *     comment); inserts ONE row into `agent_action_executions` with actor
 *     `{type:'agent', id: agentIdentifier}` on its OWN dedicated event
 *     stream (`randomUUID()` streamId, event type
 *     `AgentActionExecutionRecorded`), then advances a projection.
 *   - `executeAgentAction<T>(workspaceId, agentIdentifier, actionType, fn):
 *     Promise<AgentActionResult<T>>` -- the public v0 entry point, EXACT
 *     sequence:
 *       1. Acquire a concurrency slot via the injected `AgentConcurrencyGuard`
 *          for key `${workspaceId}:${agentIdentifier}`. `acquire() === false`
 *          -> THROWS `QuotaExceededError` immediately (NOT swallowed into a
 *          structured `AgentActionResult` -- a real, caller-visible failure).
 *       2. Inside `withAgentResourceLock`: `assertActionRateNotExceeded`
 *          (throws `QuotaExceededError` if exceeded, propagates to the
 *          caller, checked BEFORE `fn()` ever runs).
 *       3. `runInAgentSandbox(fn, {timeoutMs: env.agentSandboxTimeoutMs})`
 *          (`@luminaos/agent-runtime`) -> a structured `AgentActionResult<T>`.
 *       4. `recordAgentAction(...)` with the outcome from step 3 and a
 *          measured wall-clock `durationMs` -- best-effort, never affects the
 *          returned result even if recording itself fails.
 *       5. `finally`: release the concurrency slot acquired in step 1, even
 *          if steps 2-4 throw.
 *       6. Returns the `AgentActionResult` from step 3 UNCHANGED.
 * ============================================================================
 */

const AGENT_SANDBOX_TIMEOUT_MS = 150;
const AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = 2;
const AGENT_ACTION_RATE_LIMIT_PER_WINDOW = 3;
const AGENT_ACTION_RATE_LIMIT_WINDOW_MS = 60_000;

interface RawAgentActionExecutionRow {
  id: string;
  workspace_id: string;
  agent_identifier: string;
  action_type: string;
  outcome: string;
  duration_ms: number;
  occurred_at: Date;
}

/**
 * Locally declared (not imported), same reasoning as `agent-permission-
 * manifests.service.integration.test.ts`'s `AgentPermissionManifestContract`
 * doc comment: neither `./agent-concurrency-guard.ts` nor `./agent-
 * resource-limits.service.ts` exists yet, so a static import of either would
 * itself be an unresolved-module error. `AgentActionResult` IS imported
 * statically from `@luminaos/agent-runtime` (PR1, already merged, already a
 * declared dependency of `apps/server` as of PR2) -- unlike PR2's own test
 * file, this package does not need a local re-declaration.
 */
interface AgentConcurrencyGuardContract {
  acquire(key: string): boolean;
  release(key: string): void;
}

type AgentConcurrencyGuardConstructor = new (
  maxConcurrentPerAgent: number,
) => AgentConcurrencyGuardContract;

interface AgentResourceLimitsServiceContract {
  assertActionRateNotExceeded(workspaceId: string, agentIdentifier: string): Promise<void>;
  recordAgentAction(
    workspaceId: string,
    agentIdentifier: string,
    actionType: string,
    outcome: 'success' | 'timeout' | 'failure',
    durationMs: number,
  ): Promise<void>;
  executeAgentAction<T>(
    workspaceId: string,
    agentIdentifier: string,
    actionType: string,
    fn: () => Promise<T>,
  ): Promise<AgentActionResult<T>>;
}

type AgentResourceLimitsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  concurrencyGuard: AgentConcurrencyGuardContract,
) => AgentResourceLimitsServiceContract;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

describe('F3-T1 PR3 (RED step): AgentResourceLimitsService — rate limit (DB-backed, advisory-lock protected) + concurrency cap (in-memory) + sandboxed execution wiring (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: AgentResourceLimitsServiceContract;
  let concurrencyGuard: AgentConcurrencyGuardContract;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://agent-resource-limits-test-placeholder:6379';
    process.env.AGENT_SANDBOX_TIMEOUT_MS = String(AGENT_SANDBOX_TIMEOUT_MS);
    process.env.AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = String(
      AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT,
    );
    process.env.AGENT_ACTION_RATE_LIMIT_PER_WINDOW = String(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);
    process.env.AGENT_ACTION_RATE_LIMIT_WINDOW_MS = String(AGENT_ACTION_RATE_LIMIT_WINDOW_MS);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Imported dynamically, not statically at the top of this file -- see
    // this file's header "EXPECTED RED STATE" note.
    const guardModule: unknown = await import('./agent-concurrency-guard.js');
    const AgentConcurrencyGuardCtor = (
      guardModule as { AgentConcurrencyGuard: AgentConcurrencyGuardConstructor }
    ).AgentConcurrencyGuard;
    concurrencyGuard = new AgentConcurrencyGuardCtor(AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT);

    const serviceModule: unknown = await import('./agent-resource-limits.service.js');
    const AgentResourceLimitsServiceCtor = (
      serviceModule as { AgentResourceLimitsService: AgentResourceLimitsServiceConstructor }
    ).AgentResourceLimitsService;
    service = new AgentResourceLimitsServiceCtor(
      db,
      eventStore,
      projectionRunner,
      concurrencyGuard,
    );
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `agent-resource-limits-test-workspace-${String(workspaceCounter)}`,
        slug: `agent-resource-limits-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  async function getLatestExecutionRow(
    workspaceId: string,
    agentIdentifier: string,
  ): Promise<RawAgentActionExecutionRow | undefined> {
    const result = await db.$client.query<RawAgentActionExecutionRow>(
      `select id, workspace_id, agent_identifier, action_type, outcome, duration_ms, occurred_at
         from agent_action_executions
         where workspace_id = $1 and agent_identifier = $2
         order by occurred_at desc limit 1`,
      [workspaceId, agentIdentifier],
    );
    return result.rows[0];
  }

  async function countExecutionRows(workspaceId: string, agentIdentifier: string): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      `select count(*)::text as count from agent_action_executions
         where workspace_id = $1 and agent_identifier = $2`,
      [workspaceId, agentIdentifier],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // ---------------------------------------------------------------------
  // executeAgentAction — success / failure / timeout outcomes, each
  // independently persisted to agent_action_executions
  // ---------------------------------------------------------------------

  describe('executeAgentAction outcomes', () => {
    it('a resolving fn returns {outcome:"success", value} and records a row with outcome "success"', async () => {
      const workspaceId = await createWorkspace();
      const agentIdentifier = 'resource-limits-success-agent';

      const result = await service.executeAgentAction(
        workspaceId,
        agentIdentifier,
        'summarize-thread',
        () => Promise.resolve({ summary: 'done' }),
      );

      expect(result).toEqual({ outcome: 'success', value: { summary: 'done' } });

      const row = await getLatestExecutionRow(workspaceId, agentIdentifier);
      expect(row).toBeDefined();
      expect(row?.outcome).toBe('success');
      expect(row?.action_type).toBe('summarize-thread');
      expect(row?.agent_identifier).toBe(agentIdentifier);
      expect(row?.workspace_id).toBe(workspaceId);
    });

    it('a rejecting fn returns {outcome:"failure", error} and records a row with outcome "failure"', async () => {
      const workspaceId = await createWorkspace();
      const agentIdentifier = 'resource-limits-failure-agent';
      const boom = new Error('boom: fn rejected inside the sandbox');

      const result = await service.executeAgentAction(
        workspaceId,
        agentIdentifier,
        'draft-reply',
        () => Promise.reject(boom),
      );

      expect(result.outcome).toBe('failure');
      if (result.outcome === 'failure') {
        expect(result.error).toBe(boom);
      }

      const row = await getLatestExecutionRow(workspaceId, agentIdentifier);
      expect(row).toBeDefined();
      expect(row?.outcome).toBe('failure');
    });

    it('a never-resolving fn returns {outcome:"timeout"} (raced against env.agentSandboxTimeoutMs) and records a row with outcome "timeout"', async () => {
      const workspaceId = await createWorkspace();
      const agentIdentifier = 'resource-limits-timeout-agent';

      const result = await service.executeAgentAction(
        workspaceId,
        agentIdentifier,
        'never-completing-action',
        () => new Promise<void>(() => {}),
      );

      expect(result).toEqual({ outcome: 'timeout' });

      const row = await getLatestExecutionRow(workspaceId, agentIdentifier);
      expect(row).toBeDefined();
      expect(row?.outcome).toBe('timeout');
    }, 10_000);
  });

  // ---------------------------------------------------------------------
  // Rate limit (DB-backed, per (workspaceId, agentIdentifier))
  // ---------------------------------------------------------------------

  describe('rate limit', () => {
    it(`after ${String(AGENT_ACTION_RATE_LIMIT_PER_WINDOW)} calls, the NEXT call throws QuotaExceededError BEFORE fn is ever invoked`, async () => {
      const workspaceId = await createWorkspace();
      const agentIdentifier = 'resource-limits-rate-limit-agent';
      let callCount = 0;
      const fn = () => {
        callCount += 1;
        return Promise.resolve('ok');
      };

      for (let i = 0; i < AGENT_ACTION_RATE_LIMIT_PER_WINDOW; i += 1) {
        const result = await service.executeAgentAction(
          workspaceId,
          agentIdentifier,
          'rate-limited-action',
          fn,
        );
        expect(result).toEqual({ outcome: 'success', value: 'ok' });
      }

      expect(callCount).toBe(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);

      await expect(
        service.executeAgentAction(workspaceId, agentIdentifier, 'rate-limited-action', fn),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      // The call count must be UNCHANGED -- the rejected call's fn was never
      // invoked at all.
      expect(callCount).toBe(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);
    });

    it('two concurrent executeAgentAction calls for the SAME (workspaceId, agentIdentifier), right at the rate-limit boundary, do not both succeed (advisory-lock race safety, no TOCTOU)', async () => {
      const workspaceId = await createWorkspace();
      const agentIdentifier = 'resource-limits-race-agent';

      // Pre-fill up to exactly ONE below the limit, so the next single call
      // would be the LAST allowed one, and two concurrent calls beyond that
      // must not BOTH be let through by a racy, unlocked count-then-insert.
      for (let i = 0; i < AGENT_ACTION_RATE_LIMIT_PER_WINDOW - 1; i += 1) {
        const result = await service.executeAgentAction(
          workspaceId,
          agentIdentifier,
          'race-action',
          () => Promise.resolve('ok'),
        );
        expect(result).toEqual({ outcome: 'success', value: 'ok' });
      }

      const settled = await Promise.allSettled([
        service.executeAgentAction(workspaceId, agentIdentifier, 'race-action', () =>
          Promise.resolve('ok'),
        ),
        service.executeAgentAction(workspaceId, agentIdentifier, 'race-action', () =>
          Promise.resolve('ok'),
        ),
      ]);

      const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = settled.filter((outcome) => outcome.status === 'rejected');

      // Exactly one of the two concurrent calls may fill the last remaining
      // slot; the other must observe the limit already reached.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (rejected[0]?.status === 'rejected') {
        expect(rejected[0].reason).toBeInstanceOf(QuotaExceededError);
      }

      const finalCount = await countExecutionRows(workspaceId, agentIdentifier);
      expect(finalCount).toBe(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);
    }, 15_000);
  });

  // ---------------------------------------------------------------------
  // Concurrency cap (in-memory, per (workspaceId, agentIdentifier))
  // ---------------------------------------------------------------------

  describe('concurrency cap', () => {
    it(`${String(AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT)} concurrent in-flight calls succeed; the (cap + 1)th concurrent call throws QuotaExceededError immediately, before its fn is ever invoked`, async () => {
      const workspaceId = await createWorkspace();
      const agentIdentifier = 'resource-limits-concurrency-agent';

      const deferreds = Array.from({ length: AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT }, () =>
        createDeferred<string>(),
      );

      const inFlight = deferreds.map((deferred, index) =>
        service.executeAgentAction(
          workspaceId,
          agentIdentifier,
          `concurrent-action-${String(index)}`,
          () => deferred.promise,
        ),
      );

      // Give the in-flight calls a tick to actually acquire their
      // concurrency slots before attempting the one-over-cap call.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      let overCapFnInvoked = false;
      await expect(
        service.executeAgentAction(workspaceId, agentIdentifier, 'over-cap-action', () => {
          overCapFnInvoked = true;
          return Promise.resolve('should not run');
        }),
      ).rejects.toBeInstanceOf(QuotaExceededError);
      expect(overCapFnInvoked).toBe(false);

      // Release the held-open in-flight calls and confirm they complete
      // successfully (the cap rejection above must not have disturbed them).
      deferreds.forEach((deferred, index) => {
        deferred.resolve(`released-${String(index)}`);
      });
      const results = await Promise.all(inFlight);
      results.forEach((result, index) => {
        expect(result).toEqual({ outcome: 'success', value: `released-${String(index)}` });
      });

      // With every slot released, the concurrency cap must be available
      // again for a fresh call.
      const afterRelease = await service.executeAgentAction(
        workspaceId,
        agentIdentifier,
        'after-release-action',
        () => Promise.resolve('ok-after-release'),
      );
      expect(afterRelease).toEqual({ outcome: 'success', value: 'ok-after-release' });
    }, 15_000);
  });

  // ---------------------------------------------------------------------
  // Cross-workspace / cross-agent independence
  // ---------------------------------------------------------------------

  describe('cross-workspace / cross-agent independence', () => {
    it('the rate limit for (workspace A, agent X) is independent from (workspace B, agent X) and (workspace A, agent Y)', async () => {
      const workspaceIdA = await createWorkspace();
      const workspaceIdB = await createWorkspace();
      const agentX = 'shared-agent-identifier-x';
      const agentY = 'shared-agent-identifier-y';

      // Exhaust the rate limit for (workspaceIdA, agentX) only.
      for (let i = 0; i < AGENT_ACTION_RATE_LIMIT_PER_WINDOW; i += 1) {
        const result = await service.executeAgentAction(
          workspaceIdA,
          agentX,
          'independence-action',
          () => Promise.resolve('ok'),
        );
        expect(result).toEqual({ outcome: 'success', value: 'ok' });
      }
      await expect(
        service.executeAgentAction(workspaceIdA, agentX, 'independence-action', () =>
          Promise.resolve('ok'),
        ),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      // (workspaceIdB, agentX): different workspace, same agentIdentifier ->
      // fully independent counter, must still succeed.
      const differentWorkspace = await service.executeAgentAction(
        workspaceIdB,
        agentX,
        'independence-action',
        () => Promise.resolve('ok-different-workspace'),
      );
      expect(differentWorkspace).toEqual({ outcome: 'success', value: 'ok-different-workspace' });

      // (workspaceIdA, agentY): same workspace, different agentIdentifier ->
      // also fully independent, must still succeed.
      const differentAgent = await service.executeAgentAction(
        workspaceIdA,
        agentY,
        'independence-action',
        () => Promise.resolve('ok-different-agent'),
      );
      expect(differentAgent).toEqual({ outcome: 'success', value: 'ok-different-agent' });
    });

    it('the concurrency cap for (workspace A, agent X) is independent from (workspace B, agent X) and (workspace A, agent Y)', async () => {
      const workspaceIdA = await createWorkspace();
      const workspaceIdB = await createWorkspace();
      const agentX = 'concurrency-independence-agent-x';
      const agentY = 'concurrency-independence-agent-y';

      const deferreds = Array.from({ length: AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT }, () =>
        createDeferred<string>(),
      );
      const inFlight = deferreds.map((deferred, index) =>
        service.executeAgentAction(
          workspaceIdA,
          agentX,
          `saturating-action-${String(index)}`,
          () => deferred.promise,
        ),
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      // (workspaceIdA, agentX) is now at its concurrency cap -- a further
      // call for that SAME pair must be rejected.
      await expect(
        service.executeAgentAction(workspaceIdA, agentX, 'over-cap-action', () =>
          Promise.resolve('should not run'),
        ),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      // But (workspaceIdB, agentX) and (workspaceIdA, agentY) each have
      // their OWN fresh concurrency counter and must succeed immediately.
      const differentWorkspaceResult = await service.executeAgentAction(
        workspaceIdB,
        agentX,
        'independent-action',
        () => Promise.resolve('ok-different-workspace'),
      );
      expect(differentWorkspaceResult).toEqual({
        outcome: 'success',
        value: 'ok-different-workspace',
      });

      const differentAgentResult = await service.executeAgentAction(
        workspaceIdA,
        agentY,
        'independent-action',
        () => Promise.resolve('ok-different-agent'),
      );
      expect(differentAgentResult).toEqual({ outcome: 'success', value: 'ok-different-agent' });

      deferreds.forEach((deferred, index) => {
        deferred.resolve(`released-${String(index)}`);
      });
      await Promise.all(inFlight);
    }, 15_000);
  });

  // ---------------------------------------------------------------------
  // recordAgentAction best-effort behavior
  // ---------------------------------------------------------------------

  describe('best-effort recording', () => {
    it('a recordAgentAction failure (a workspaceId that violates the agent_action_executions FK) does not prevent executeAgentAction from returning the correct AgentActionResult', async () => {
      // Deliberately NOT inserted into `workspaces` -- `agent_action_executions
      // .workspace_id` references `workspaces.id`, so an insert attempt for
      // this workspaceId will violate that foreign key inside
      // `recordAgentAction`'s own try/catch. The rate-limit SELECT itself
      // does not require an existing workspace row, so this only exercises
      // the RECORDING half's best-effort guarantee, not the rate check.
      const nonExistentWorkspaceId = randomUUID();
      const agentIdentifier = 'resource-limits-best-effort-agent';

      const result = await service.executeAgentAction(
        nonExistentWorkspaceId,
        agentIdentifier,
        'best-effort-action',
        () => Promise.resolve('primary-result-unaffected'),
      );

      expect(result).toEqual({ outcome: 'success', value: 'primary-result-unaffected' });
    });
  });
});
