import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Real, end-to-end integration test for F1-T7's CORS acceptance criterion:
 * `apps/web` (Vite dev origin `http://localhost:5173`) must be able to send
 * `credentials: 'include'` cross-origin requests to `apps/server` (port
 * 3000) and have the browser accept the response. That only works if the
 * server opts in explicitly with `app.enableCors({ origin: <web origin>,
 * credentials: true })` (per `apps/server/src/auth/auth.controller.ts`'s
 * `sameSite: 'lax'`, `httpOnly` session cookie) -- the wildcard `Access-
 * Control-Allow-Origin: *` a browser would otherwise fall back to is
 * explicitly forbidden by the CORS spec whenever `Access-Control-Allow-
 * Credentials: true` is also required, so an explicit, non-wildcard
 * allowlist is the only correct fix.
 *
 * `apps/server/src/main.ts` (18 lines, read in full) currently does NOT call
 * `app.enableCors(...)` at all -- CORS is completely off. This test is
 * therefore EXPECTED TO FAIL (red) until an `implementer` adds that call.
 * Nothing about this test's assertions should need to change once that
 * implementation lands; only `main.ts` (or an equivalent bootstrap-level
 * config module) should need to change.
 *
 * Follows the same Testcontainers + `Test.createTestingModule({imports:
 * [AppModule]})` + `supertest` pattern established in
 * `./auth/tenant-isolation.integration.test.ts`: a throwaway Postgres 16 +
 * Redis 7 container pair, real migrations, the real `AppModule` (not a
 * hand-picked subset of controllers/providers), driven purely over HTTP.
 *
 * `GET /health` (`./health/health.module.ts`) is used as the target route
 * for every assertion here rather than an authenticated route like `/me`:
 * it needs no session cookie and always resolves (its body's `status` field
 * is irrelevant to this file -- only the CORS response *headers* matter),
 * which keeps every assertion here scoped to CORS and nothing else.
 *
 * ASSUMPTION (implementer: adjust this test if wrong, mirroring
 * `tenant-isolation.integration.test.ts`'s own documented assumption): the
 * web app's dev origin the server must allowlist is exactly
 * `http://localhost:5173` (Vite's default dev port, per this task's own
 * brief) -- if the real configured origin differs (e.g. read from an env
 * var with a different default), update `ALLOWED_WEB_ORIGIN` below to match
 * rather than guessing further.
 */

const ALLOWED_WEB_ORIGIN = 'http://localhost:5173';
const FOREIGN_ORIGIN = 'http://evil.example.com';

describe('CORS (real Postgres + real HTTP, via Testcontainers + supertest) -- F1-T7', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // AppModule is imported/built only after both env vars are set, mirroring
    // every other Testcontainers-driven integration test in this codebase.
    const { AppModule } = await import('./app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  it('preflight OPTIONS from the allowed web origin gets Access-Control-Allow-Origin + Access-Control-Allow-Credentials: true', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server)
      .options('/health')
      .set('Origin', ALLOWED_WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a real GET request from the allowed web origin gets the same two CORS headers on the actual response', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server).get('/health').set('Origin', ALLOWED_WEB_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('preflight OPTIONS from a foreign, non-allowlisted origin does NOT get Access-Control-Allow-Origin/-Credentials headers', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server)
      .options('/health')
      .set('Origin', FOREIGN_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    // The core negative proof: an allowlist must not reflect an arbitrary
    // Origin back -- neither header may be present for an origin that was
    // never granted access. (Asserting `undefined`, not merely "!==
    // FOREIGN_ORIGIN", also rules out a wildcard `'*'` fallback, which is
    // itself invalid whenever credentials are involved.)
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('a real GET request from a foreign, non-allowlisted origin does NOT get Access-Control-Allow-Origin/-Credentials headers', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server).get('/health').set('Origin', FOREIGN_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
