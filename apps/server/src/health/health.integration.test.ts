import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer as RedisContainerModuleExport } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Real, end-to-end integration test for F0-T8 PR-C's AC4: "/health DB
 * kapalıyken degraded döner (Testcontainers ile kanıtlı)."
 *
 * Follows the same Testcontainers + `Test.createTestingModule({imports:
 * [AppModule]})` + `supertest` pattern established in
 * `../auth/tenant-isolation.integration.test.ts` and
 * `../observability/request-logging.integration.test.ts`: real Postgres 16
 * + real Redis 7 throwaway containers, real migrations, the real
 * `AppModule` (not a hand-picked subset), driven purely over HTTP -- no
 * mocking of DB/Redis.
 *
 * `@testcontainers/redis`'s `RedisContainer`/`StartedRedisContainer` is not
 * installed yet (per the plan: "mirror the typed-package convention this
 * repo already follows for Postgres" -- `@testcontainers/postgresql` --
 * rather than hand-rolling `GenericContainer('redis:7')`). This test is
 * expected to fail with "Cannot find module '@testcontainers/redis'" (and,
 * once that's installed, "Cannot find module '../health/health.service.js'"
 * / `'../redis/...'` / etc., depending on what implementer lands first)
 * until PR-C's implementation is in place.
 *
 * NEW PATTERN vs. every other integration test in this codebase: this is
 * the first test that stops a Testcontainers container *mid-test* (the
 * Postgres one, in the AC4 assertion below) rather than only in `afterAll`
 * teardown. See that `it()` and this file's `afterAll` for how the
 * resulting double-stop risk is handled.
 *
 * ASSUMPTION (implementer: adjust this test if wrong, mirroring
 * `tenant-isolation.integration.test.ts`'s own documented assumption about
 * `DATABASE_URL`): `AppModule`'s new Redis module is expected to read its
 * connection string from `process.env.REDIS_URL` at module-init time, per
 * the plan's `apps/server/src/config/env.ts` gaining a `redisUrl` field
 * mirroring the existing `databaseUrl` one. Set here, before building the
 * testing module, exactly like `DATABASE_URL` already is.
 */

interface HealthResponseBody {
  status: 'ok' | 'degraded';
  checks: { db: 'ok' | 'error'; redis: 'ok' | 'error' };
  version: string;
}

// LINT NOTE (mirrors ../health/health.service.test.ts's own note): since
// `@testcontainers/redis` isn't installed yet, its named exports resolve to
// `any`, which would otherwise cascade `@typescript-eslint/no-unsafe-*`
// errors through every line touching `redisContainer` on top of the one
// genuinely-expected `import-x/no-unresolved` error this file is supposed
// to fail with. This local structural type + single cast is the narrow
// escape hatch (mirrors `db/client.ts`'s `as unknown as Pool['query']`
// pattern) -- once the real package is installed, delete both and import
// `RedisContainer`/`StartedRedisContainer` directly.
interface StartedRedisContainerLike {
  getConnectionUrl: () => string;
  stop: () => Promise<unknown>;
}

interface RedisContainerConstructor {
  new (image: string): { start: () => Promise<StartedRedisContainerLike> };
}

const RedisContainer = RedisContainerModuleExport as unknown as RedisContainerConstructor;

function assertNonEmptyVersionString(body: HealthResponseBody): void {
  expect(typeof body.version).toBe('string');
  expect(body.version.length).toBeGreaterThan(0);
}

describe('GET /health (real Postgres + real Redis, via Testcontainers + supertest) -- AC4', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainerLike;
  let app: INestApplication;
  let pgAlreadyStopped = false;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = pgContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(pgContainer.getConnectionUri());

    // AppModule (and everything it imports -- DbModule, the new RedisModule,
    // HealthModule, etc.) is imported/built only after both env vars are
    // set, mirroring every other Testcontainers-driven integration test in
    // this codebase.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();

    // The AC4 test below deliberately stops `pgContainer` mid-test to prove
    // /health degrades live -- if it already ran, calling `.stop()` again
    // here would double-stop an already-stopped container. Testcontainers'
    // own behavior for a redundant `.stop()` call is not something this
    // suite should depend on either way, so the flag is checked first and,
    // as a second line of defense, the call itself is wrapped so a
    // double-stop can never fail this file's teardown (and mask which test
    // actually failed, if any did).
    if (!pgAlreadyStopped) {
      try {
        await pgContainer.stop();
      } catch {
        // Already gone or otherwise unreachable -- nothing left to clean up.
      }
    }

    await redisContainer.stop();
  }, 60_000);

  it('DB and Redis both reachable: GET /health returns 200 {status: "ok", checks: {db: "ok", redis: "ok"}, version}', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server).get('/health');

    expect(response.status).toBe(200);
    const body = response.body as HealthResponseBody;
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ db: 'ok', redis: 'ok' });
    assertNonEmptyVersionString(body);
  });

  // Generous but explicit and bounded: this assertion only holds if
  // HealthService's own `withTimeout` wrapper actually bounds the failed DB
  // probe -- if a regression reintroduces an unbounded hang, this test must
  // fail loudly well before Testcontainers'/vitest's own outer timeouts,
  // not silently eat the whole suite's time budget.
  const AC4_TEST_TIMEOUT_MS = 10_000;

  it(
    'AC4: stopping the Postgres container mid-test makes GET /health report degraded (still HTTP 200, checks.db: "error", checks.redis unaffected) -- bounded by HealthService\'s own timeout, never left hanging',
    async () => {
      const server: Server = app.getHttpServer() as Server;

      // The core AC4 proof: stop the real Postgres container WHILE the app
      // is still running (no other integration test in this codebase does
      // this -- see this file's `afterAll` for how the resulting
      // double-stop is handled).
      await pgContainer.stop();
      pgAlreadyStopped = true;

      const response = await request(server).get('/health');

      // Per the plan: "HTTP her zaman 200 (503 değil -- spec'in kelimesi
      // 'degraded döner', ayrı bir readiness-probe semantiği icat
      // edilmiyor)." `degraded` lives in the response BODY, not the status
      // code.
      expect(response.status).toBe(200);
      const body = response.body as HealthResponseBody;
      expect(body.status).toBe('degraded');
      expect(body.checks.db).toBe('error');
      expect(body.checks.redis).toBe('ok');
      assertNonEmptyVersionString(body);
    },
    AC4_TEST_TIMEOUT_MS,
  );
});
