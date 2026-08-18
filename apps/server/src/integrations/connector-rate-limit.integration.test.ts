import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QuotaExceededError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';

/**
 * F2-T9 PR2 (RED step), ADR-0025 §l — `ConnectorRateLimitService`
 * (`./connector-rate-limit.service.ts`, does NOT exist yet), backed by a NEW
 * `connector_rate_limit_buckets` table (does not exist yet -- no schema file,
 * no migration).
 *
 * ============================================================================
 * HARNESS CHOICE: same reasoning as `./connector-credentials.integration.test.ts`'s
 * header -- `ConnectorRateLimitService` has one constructor dependency
 * (`Database`) and no controller (ADR-0025 §n), so this file follows
 * `../ai/ai-usage.service.integration.test.ts`'s direct-instantiation,
 * no-Nest-boot precedent (a strictly closer match than the calendar
 * HTTP-harness files) rather than
 * `../calendar/calendar-token-refresh.integration.test.ts`'s full app boot.
 * `REDIS_URL` is set to an inert placeholder only because `../config/env.js`
 * exits fatally at import time if unset -- nothing here connects to it.
 *
 * `connector_rate_limit_buckets` SCHEMA DESIGN (this file's own judgment
 * call, per ADR-0025 §l's explicit delegation -- "implementer tarafından PR2
 * kapsamında... implementer PR2 sırasında test-writer/implementer tarafından
 * sonuçlandırılır"): one row per (workspace_id, connector_type) pair,
 * PRIMARY KEY on that pair (mirrors `connector_credentials`'s own
 * unique-triple-key reasoning, ADR-0025 §i, minus the `user_id` leg -- a rate
 * limit bucket is scoped to a connector-in-a-workspace, not
 * connector-per-user). Columns, carrying `RateLimitBucketState`'s four
 * fields verbatim (ADR-0025 §h):
 *   - workspace_id uuid  (FK -> workspaces, cascade)
 *   - connector_type varchar(50)  (same width as `connector_credentials.connector_type`)
 *   - capacity integer not null
 *   - tokens_available double precision not null  (fractional -- ADR-0025 §h's own example refills fractionally)
 *   - refill_per_ms double precision not null  (fractional, per §h)
 *   - last_refill_at_ms bigint not null  (epoch-ms, matching `RateLimitBucketState.lastRefillAtMs`'s own type)
 * `implementer` may adjust exact Drizzle column types (e.g. `real` vs
 * `doublePrecision`, `bigint` vs a `timestamptz`) if needed to typecheck
 * cleanly, but the (workspace_id, connector_type) uniqueness and the four
 * `RateLimitBucketState` fields' SEMANTICS must stay as tested below.
 *
 * BUCKET-SEEDING APPROACH (this file's own judgment call, per the task
 * brief's explicit delegation -- no public "create bucket" API is pinned by
 * ADR-0025 §l): this file assumes `ConnectorRateLimitService` AUTO-CREATES a
 * bucket row with sane defaults on first use of a never-seen
 * (workspaceId, connectorType) pair (test 1 below pins ONLY that this
 * doesn't throw -- it deliberately does NOT pin the exact default
 * capacity/refill values, since those are `implementer`'s call). EVERY OTHER
 * test below needs precise, deterministic control over a bucket's exact
 * state to assert exhaustion/concurrency behavior, so those tests
 * pre-seed the bucket row directly via raw SQL
 * (`insert ... on conflict (workspace_id, connector_type) do update ...`)
 * BEFORE calling the service -- this is simpler than requiring the service
 * to expose a dedicated seeding API that ADR-0025 never pins, and keeps this
 * file's fixtures self-contained. `implementer`: if a different
 * bucket-creation strategy is chosen (e.g. "no row = always allowed" instead
 * of "auto-create with defaults"), only test 1 needs revisiting -- every
 * other test seeds its own row explicitly and does not depend on the
 * auto-create default's exact values.
 *
 * `refillPerMs = 0` is used throughout the exhaustion/concurrency tests
 * (rather than a nonzero rate) specifically so elapsed real wall-clock time
 * between seeding and the assertion contributes ZERO refill -- keeping those
 * tests fully deterministic regardless of how many milliseconds actually
 * elapse during the test run. Test 5 (persistence-on-denial) is the one
 * exception -- it deliberately uses a nonzero `refillPerMs` because that is
 * exactly the behavior it needs to observe.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./connector-rate-limit.service.ts` nor
 * the `connector_rate_limit_buckets` table/migration exist yet. `beforeAll`'s
 * dynamic `import('./connector-rate-limit.service.js')` rejects with a
 * "Cannot find module" resolution error, failing every test in this file at
 * setup -- this is the correct red, not a test-logic bug. (Once the service
 * module exists but the migration doesn't, the red state shifts to each raw
 * SQL seed/query rejecting with `relation "connector_rate_limit_buckets" does
 * not exist`, equally a legitimate "implementation incomplete" red.)
 * ============================================================================
 */

interface ConnectorRateLimitServiceContract {
  assertNotRateLimited(workspaceId: string, connectorType: string, cost: number): Promise<void>;
}

type ConnectorRateLimitServiceConstructor = new (db: Database) => ConnectorRateLimitServiceContract;

interface SeedBucketState {
  capacity: number;
  tokensAvailable: number;
  refillPerMs: number;
  lastRefillAtMs: number;
}

interface RawBucketRow {
  tokens_available: number;
  last_refill_at_ms: string;
}

describe('ConnectorRateLimitService (real Postgres via Testcontainers, ADR-0025 §l)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: ConnectorRateLimitServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://connector-rate-limit-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./connector-rate-limit.service.ts` -- see this file's header for why
    // the resulting `import-x/no-unresolved` finding is expected and
    // contained to this one line.
    const importedModule: unknown = await import('./connector-rate-limit.service.js');
    const ConnectorRateLimitServiceCtor = (
      importedModule as { ConnectorRateLimitService: ConnectorRateLimitServiceConstructor }
    ).ConnectorRateLimitService;
    service = new ConnectorRateLimitServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  function freshWorkspaceId(): string {
    // No FK to a real `workspaces` row is exercised here (the schema design
    // documented above puts a FK on workspace_id, but this file only needs a
    // syntactically-valid, per-test-unique uuid to key buckets by -- if
    // `implementer`'s real schema enforces the FK strictly, this helper
    // switches to inserting a real `workspaces` row first, matching
    // `./connector-credentials.integration.test.ts`'s `createWorkspace`).
    return crypto.randomUUID();
  }

  async function seedBucket(
    workspaceId: string,
    connectorType: string,
    state: SeedBucketState,
  ): Promise<void> {
    await db.$client.query(
      `insert into connector_rate_limit_buckets
         (workspace_id, connector_type, capacity, tokens_available, refill_per_ms, last_refill_at_ms)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (workspace_id, connector_type) do update set
         capacity = excluded.capacity,
         tokens_available = excluded.tokens_available,
         refill_per_ms = excluded.refill_per_ms,
         last_refill_at_ms = excluded.last_refill_at_ms`,
      [
        workspaceId,
        connectorType,
        state.capacity,
        state.tokensAvailable,
        state.refillPerMs,
        state.lastRefillAtMs,
      ],
    );
  }

  async function rawBucketRow(
    workspaceId: string,
    connectorType: string,
  ): Promise<RawBucketRow | undefined> {
    const result = await db.$client.query<RawBucketRow>(
      `select tokens_available, last_refill_at_ms::text as last_refill_at_ms
         from connector_rate_limit_buckets where workspace_id = $1 and connector_type = $2`,
      [workspaceId, connectorType],
    );
    return result.rows[0];
  }

  it('1. a never-seen (workspaceId, connectorType) pair: the first call auto-creates a bucket and does not throw for a small cost', async () => {
    const workspaceId = freshWorkspaceId();

    await expect(
      service.assertNotRateLimited(workspaceId, 'google-drive', 1),
    ).resolves.toBeUndefined();
  });

  it('2. a call within capacity succeeds (no throw)', async () => {
    const workspaceId = freshWorkspaceId();
    await seedBucket(workspaceId, 'slack', {
      capacity: 10,
      tokensAvailable: 10,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    await expect(service.assertNotRateLimited(workspaceId, 'slack', 5)).resolves.toBeUndefined();
  });

  it('3. repeated calls that exhaust the bucket eventually throw QuotaExceededError', async () => {
    const workspaceId = freshWorkspaceId();
    await seedBucket(workspaceId, 'github', {
      capacity: 5,
      tokensAvailable: 5,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    // First call of cost 3 fits (5 available) and leaves 2.
    await expect(service.assertNotRateLimited(workspaceId, 'github', 3)).resolves.toBeUndefined();

    // Second call of cost 3 does NOT fit (only 2 left, refillPerMs=0 means no
    // catch-up) -- must be denied.
    await expect(service.assertNotRateLimited(workspaceId, 'github', 3)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('4. the lock/bucket key is per (workspaceId, connectorType): two DIFFERENT connectorTypes in the SAME workspace have fully independent limits', async () => {
    const workspaceId = freshWorkspaceId();
    await seedBucket(workspaceId, 'notion', {
      capacity: 1,
      tokensAvailable: 1,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });
    await seedBucket(workspaceId, 'gmail', {
      capacity: 1,
      tokensAvailable: 1,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    // Exhaust 'notion' entirely.
    await expect(service.assertNotRateLimited(workspaceId, 'notion', 1)).resolves.toBeUndefined();
    await expect(service.assertNotRateLimited(workspaceId, 'notion', 1)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );

    // 'gmail', a DIFFERENT connectorType in the SAME workspace, must be
    // completely unaffected -- if the two shared a single bucket/lock key,
    // this call would incorrectly also be denied.
    await expect(service.assertNotRateLimited(workspaceId, 'gmail', 1)).resolves.toBeUndefined();
  });

  it('5. a DENIED call still persists the refill catch-up (nextState is persisted unconditionally, per ADR-0025 §h)', async () => {
    const workspaceId = freshWorkspaceId();
    const fiveSecondsAgo = Date.now() - 5_000;

    // capacity 10, starts at 0, refills 0.001 tokens/ms (1 token/sec) -- by
    // "now" (~5s later), refilledAmount should be ~5, still short of the
    // cost of 8 requested below, so the call must be DENIED, but the refill
    // catch-up to ~5 (and the advanced lastRefillAtMs) must still be saved.
    await seedBucket(workspaceId, 'calendar', {
      capacity: 10,
      tokensAvailable: 0,
      refillPerMs: 0.001,
      lastRefillAtMs: fiveSecondsAgo,
    });

    await expect(service.assertNotRateLimited(workspaceId, 'calendar', 8)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );

    const row = await rawBucketRow(workspaceId, 'calendar');
    expect(row).toBeDefined();
    // Refilled to roughly 5 tokens (allow generous tolerance for real
    // wall-clock time elapsed during the test itself).
    expect(row?.tokens_available ?? 0).toBeGreaterThan(4);
    expect(row?.tokens_available ?? 0).toBeLessThan(6);
    // lastRefillAtMs must have been advanced to "now" (well after the
    // original seeded value from 5 seconds ago), proving persistence
    // happened even though the call was denied.
    expect(Number(row?.last_refill_at_ms ?? '0')).toBeGreaterThan(fiveSecondsAgo + 4_000);
  });

  it('6. the critical concurrency test: two TRULY CONCURRENT calls against a bucket sized so exactly ONE cost fits -- exactly one succeeds, the other throws QuotaExceededError (proves pg_advisory_lock serializes the check-then-record critical section)', async () => {
    const workspaceId = freshWorkspaceId();
    await seedBucket(workspaceId, 'google-drive', {
      capacity: 5,
      tokensAvailable: 5,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    // Each call costs 3; capacity is 5 -- only ONE of the two concurrent
    // calls can possibly fit (3+3=6 > 5). Without a serializing lock around
    // the check-then-record critical section, a TOCTOU race could let BOTH
    // read "5 available" before either persists its deduction, incorrectly
    // letting both succeed.
    const [first, second] = await Promise.allSettled([
      service.assertNotRateLimited(workspaceId, 'google-drive', 3),
      service.assertNotRateLimited(workspaceId, 'google-drive', 3),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);

    const rejected = first.status === 'rejected' ? first : (second as PromiseRejectedResult);
    expect(rejected.reason).toBeInstanceOf(QuotaExceededError);
  }, 15_000);
});
