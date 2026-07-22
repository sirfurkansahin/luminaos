import { describe, expect, it, vi } from 'vitest';

import { HealthService as HealthServiceModuleExport } from './health.service.js';

/**
 * Unit tests (no I/O, no Testcontainers) for F0-T8 PR-C's `HealthService`,
 * per the approved plan (`giggly-brewing-moore.md`, PR-C): "DB + Redis
 * bağlantıları enjekte eder, her iki probe'u da `Promise.allSettled` + bir
 * `withTimeout` sarmalayıcısıyla çalıştırır." This file exercises the
 * decision logic in isolation, against hand-mocked DB/Redis probes -- the
 * real-container proof that this wiring actually reaches a real Postgres +
 * Redis lives in `./health.integration.test.ts` (AC4).
 *
 * =============================== CONTRACT DESIGNED HERE (not yet
 * implemented -- `./health.service.ts` does not exist)
 * ===============================
 *
 * `HealthService` is a plain, framework-agnostic-shaped class (constructed
 * directly here with `new HealthService(db, redis, options)`, mirroring how
 * `EventStoreService` is constructed directly in
 * `event-store/event-store.integration.test.ts` rather than pulled through
 * Nest DI) -- Nest wiring (the real `Database`/`ioredis` clients, injected
 * via `@Inject(DATABASE_CONNECTION)`/`@Inject(REDIS_CONNECTION)`) is
 * `health.module.ts`'s job, not tested here.
 *
 *   export interface HealthServiceOptions {
 *     // Upper bound, in milliseconds, each individual probe (db OR redis)
 *     // is allowed to take before being treated as failed ('error') even if
 *     // its underlying promise never settles. Defaults to 2000 per the
 *     // plan ("withTimeout(2000ms)"). Overridable so tests (this file) can
 *     // prove the timeout behavior in milliseconds, not real seconds.
 *     timeoutMs?: number;
 *   }
 *
 *   // Structural, not the real Drizzle `Database`/`ioredis` `Redis` types --
 *   // HealthService only ever needs to know how to ask each dependency "are
 *   // you alive", so it depends on the NARROWEST shape that lets it do that
 *   // (Liskov-substitutable by the real clients: Drizzle's `Database` has an
 *   // `.execute(...)` method, `ioredis`'s `Redis` has a `.ping()` method --
 *   // both real production types are structurally assignable to these, no
 *   // adapter needed at the real call site).
 *   export interface HealthDatabaseProbe {
 *     execute(query: unknown): Promise<unknown>;
 *   }
 *   export interface HealthRedisProbe {
 *     ping(): Promise<string>;
 *   }
 *
 *   export class HealthService {
 *     constructor(
 *       db: HealthDatabaseProbe,
 *       redis: HealthRedisProbe,
 *       options?: HealthServiceOptions,
 *     );
 *
 *     // Runs both probes concurrently (Promise.allSettled), each individually
 *     // bounded by `options.timeoutMs` (default 2000) via a `withTimeout`
 *     // wrapper -- a probe that neither resolves nor rejects within that
 *     // window is treated exactly like a rejection ('error'), never left
 *     // pending. `status` is 'ok' only when BOTH checks are 'ok'; any single
 *     // failure -> 'degraded' (never a distinct "fully down" status -- the
 *     // plan only defines the two-value enum). `version` is a non-empty
 *     // string in every case (implementer: read it from `./version.ts`,
 *     // build-time from `package.json`, per the plan -- this test does not
 *     // pin its exact value, only its shape).
 *     check(): Promise<HealthCheckPayload>; // HealthCheckPayload per @luminaos/shared, widened per plan to {status, checks, version}
 *   }
 *
 * Why probes are duck-typed objects with `execute`/`ping` rather than plain
 * `() => Promise<unknown>` callbacks: it keeps this test's mocks visibly
 * traceable to the real dependency each one stands in for (a db mock has
 * `.execute`, a redis mock has `.ping`), and lets `health.module.ts`'s
 * factory wire the real `DATABASE_CONNECTION`/`REDIS_CONNECTION` instances
 * straight through with zero adapter code. Implementer: if a different
 * shape is chosen instead (e.g. plain probe callbacks), please update this
 * test file to match and note the deviation -- the *test cases* below (which
 * combination of db/redis success/failure/hang maps to which
 * `HealthCheckPayload`) are the actual acceptance-relevant contract, not the
 * exact constructor parameter shape.
 *
 * LINT NOTE: this file's own local `HealthCheckPayload`/`HealthService*`
 * interfaces below are NOT re-declarations of a different contract -- they
 * exist purely so this test file has something typed to check against while
 * `./health.service.ts` doesn't exist yet (an unresolved import's binding is
 * implicitly `any`, which would otherwise cascade `@typescript-eslint/
 * no-unsafe-*` errors through every line that touches it, on top of the one
 * genuinely-expected `import-x/no-unresolved` error this file is supposed to
 * fail with). The single `as unknown as HealthServiceConstructor` cast below
 * is the one deliberate, narrow escape hatch (mirrors the same pattern
 * already used in `db/client.ts`'s `pool.query = tracedQuery as unknown as
 * Pool['query']`) -- once `health.service.ts` exists with this exact shape,
 * the cast becomes a no-op and can be deleted along with these local types in
 * favor of importing the real ones.
 */

interface HealthCheckPayload {
  status: 'ok' | 'degraded';
  checks: { db: 'ok' | 'error'; redis: 'ok' | 'error' };
  version: string;
}

// Function-typed properties (not TS "method shorthand" syntax) deliberately:
// `@typescript-eslint/unbound-method` flags a bare reference to a method
// declared with shorthand syntax (`execute(...): ...`) as potentially
// unsafe `this`-binding, even for a plain mock function stored on a
// structural mock object -- these are properties holding a function value,
// never called off a `this`-bearing prototype, so the shorthand form would
// only produce lint noise unrelated to this file's actual subject.
interface HealthDatabaseProbe {
  execute: (query: unknown) => Promise<unknown>;
}

interface HealthRedisProbe {
  ping: () => Promise<string>;
}

interface HealthServiceOptions {
  timeoutMs?: number;
}

interface HealthServiceInstance {
  check: () => Promise<HealthCheckPayload>;
}

interface HealthServiceConstructor {
  new (
    db: HealthDatabaseProbe,
    redis: HealthRedisProbe,
    options?: HealthServiceOptions,
  ): HealthServiceInstance;
}

const HealthService = HealthServiceModuleExport as unknown as HealthServiceConstructor;

const SHORT_TIMEOUT_MS = 50;

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Deliberately never settles -- simulates a hung connection so the
    // service's own `withTimeout` wrapper is what bounds this test's
    // runtime, not an unrelated real-world hang.
  });
}

function assertVersionIsNonEmptyString(payload: HealthCheckPayload): void {
  expect(typeof payload.version).toBe('string');
  expect(payload.version.length).toBeGreaterThan(0);
}

describe('HealthService.check()', () => {
  it('both DB and Redis probes succeed -> {status: "ok", checks: {db: "ok", redis: "ok"}}', async () => {
    const db: HealthDatabaseProbe = { execute: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) };
    const redis: HealthRedisProbe = { ping: vi.fn().mockResolvedValue('PONG') };

    const service = new HealthService(db, redis);
    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ db: 'ok', redis: 'ok' });
    assertVersionIsNonEmptyString(result);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('DB probe rejects -> {status: "degraded", checks: {db: "error", redis: "ok"}}', async () => {
    const db: HealthDatabaseProbe = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const redis: HealthRedisProbe = { ping: vi.fn().mockResolvedValue('PONG') };

    const service = new HealthService(db, redis);
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ db: 'error', redis: 'ok' });
    assertVersionIsNonEmptyString(result);
  });

  it('Redis probe rejects -> {status: "degraded", checks: {db: "ok", redis: "error"}}', async () => {
    const db: HealthDatabaseProbe = { execute: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) };
    const redis: HealthRedisProbe = { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };

    const service = new HealthService(db, redis);
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ db: 'ok', redis: 'error' });
    assertVersionIsNonEmptyString(result);
  });

  it('both DB and Redis probes reject -> {status: "degraded", checks: {db: "error", redis: "error"}}', async () => {
    const db: HealthDatabaseProbe = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const redis: HealthRedisProbe = { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };

    const service = new HealthService(db, redis);
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ db: 'error', redis: 'error' });
    assertVersionIsNonEmptyString(result);
  });

  it('a DB probe that never resolves is bounded by the injected timeout, reported as "error" rather than hanging the request', async () => {
    const db: HealthDatabaseProbe = { execute: vi.fn(() => neverResolves<unknown>()) };
    const redis: HealthRedisProbe = { ping: vi.fn().mockResolvedValue('PONG') };

    // Short injected timeout so this test proves the bound without a real
    // multi-second wait -- see HealthServiceOptions contract above.
    const service = new HealthService(db, redis, { timeoutMs: SHORT_TIMEOUT_MS });
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ db: 'error', redis: 'ok' });
    assertVersionIsNonEmptyString(result);
  }, 2_000); // of silently eating the whole test run's time budget. // regression reintroduces an unbounded hang, this fails loudly instead // Generous but still far below vitest's own 5s default -- if a

  it('a Redis probe that never resolves is bounded by the injected timeout, reported as "error" rather than hanging the request', async () => {
    const db: HealthDatabaseProbe = { execute: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) };
    const redis: HealthRedisProbe = { ping: vi.fn(() => neverResolves<string>()) };

    const service = new HealthService(db, redis, { timeoutMs: SHORT_TIMEOUT_MS });
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ db: 'ok', redis: 'error' });
    assertVersionIsNonEmptyString(result);
  }, 2_000);

  it('both probes hang -> bounded by the injected timeout, both reported "error", still resolves', async () => {
    const db: HealthDatabaseProbe = { execute: vi.fn(() => neverResolves<unknown>()) };
    const redis: HealthRedisProbe = { ping: vi.fn(() => neverResolves<string>()) };

    const service = new HealthService(db, redis, { timeoutMs: SHORT_TIMEOUT_MS });
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ db: 'error', redis: 'error' });
    assertVersionIsNonEmptyString(result);
  }, 2_000);
});
