import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Real, end-to-end integration test for F0-T5's central acceptance
 * criterion: register -> login -> GET /me -> create workspace -> a second
 * user cannot read the first user's workspace (403).
 *
 * Nothing here is mocked. A throwaway Postgres 16 container is started via
 * Testcontainers, migrations are run against it for real, and a real Nest
 * application (the actual `AppModule`, not a hand-picked subset of
 * controllers/providers) is booted and driven purely over HTTP with
 * `supertest` — no reaching into controller instances or service internals.
 *
 * ASSUMPTION (implementer: adjust this test if wrong): `AppModule`'s
 * `DbModule` is expected to read its Postgres connection string from
 * `process.env.DATABASE_URL` at module-init time (per the plan's
 * `apps/server/src/config/env.ts`). We set that env var to the container's
 * connection URI *before* building the testing module below. If the real
 * env var name differs, update this test to match rather than guessing.
 *
 * F0-T8 PR-C ADDITION: `AppModule` now also imports a `RedisModule`, whose
 * `env.ts`-backed `REDIS_URL` is validated fail-fast at process boot
 * alongside `DATABASE_URL` (same `readEnv()` function, per
 * `config/env.ts`) — a throwaway Redis 7 Testcontainer is started here too,
 * even though this file's own assertions never touch Redis, purely so
 * `AppModule` can boot at all.
 */

const USER_A = { email: 'user-a@example.com', password: 'correct-horse-battery' };
const USER_B = { email: 'user-b@example.com', password: 'another-strong-pw' };

/**
 * Minimal expected response-body shapes for this test's own assertions.
 * `superagent.Response.body` is typed `any` (it varies per-request, since
 * superagent can't know our API's contract) — these interfaces are the one
 * controlled boundary where that `any` is converted into the concrete shape
 * this test expects the API to return, per the task's acceptance criteria.
 * If the real API returns something else, the `.email`/`.id` assertions
 * below fail loudly (`undefined !== '...'`) rather than silently passing.
 */
interface UserEnvelope {
  user: { email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

/**
 * Turns a supertest/superagent multi-`Set-Cookie` response header into a
 * single `Cookie` request header value (`name=value; name2=value2`), without
 * assuming or hardcoding the session cookie's name.
 *
 * Deliberately uses `response.get('Set-Cookie')` rather than
 * `response.headers['set-cookie']`: per `@types/superagent`'s
 * `response-base.d.ts`, `.get()` has a literal-string-keyed overload
 * (`get(header: "Set-Cookie"): string[] | undefined`) that accurately
 * reflects Node's raw `http.IncomingMessage` behavior of returning multiple
 * `Set-Cookie` lines as an array — whereas the generic `.headers` property is
 * typed as a plain `{ [index: string]: string }` dict and would misrepresent
 * the real shape.
 */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('tenant isolation (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // AppModule (and everything it imports — AuthModule, WorkspacesModule,
    // DbModule, etc.) is imported/built only after DATABASE_URL is set, so
    // any env-read-at-module-init-time config picks up the test container.
    const { AppModule } = await import('../app.module.js');

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

  it('full flow: register -> /me -> create workspace -> cross-tenant 403 -> login -> logout', async () => {
    // `INestApplication#getHttpServer()` is typed `any` in `@nestjs/common`
    // (it can be an Express or Fastify server depending on adapter) — this
    // is the one controlled boundary where that leaks in, cast once to the
    // real runtime type (platform-express's Node `http.Server`) instead of
    // letting `any` propagate through every `request(server)` call below.
    const server: Server = app.getHttpServer() as Server;

    // 1. Register user A.
    const registerAResponse = await request(server).post('/auth/register').send(USER_A);

    expect(registerAResponse.status).toBe(201);
    expect((registerAResponse.body as UserEnvelope).user.email).toBe(USER_A.email);
    const userACookie = toCookieHeader(registerAResponse.get('Set-Cookie'));

    // 2. GET /me as user A.
    const meAResponse = await request(server).get('/me').set('Cookie', userACookie);

    expect(meAResponse.status).toBe(200);
    expect((meAResponse.body as UserEnvelope).user.email).toBe(USER_A.email);

    // 3. Create a workspace as user A.
    const createWorkspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', userACookie)
      .send({ name: 'Acme Corp' });

    expect(createWorkspaceResponse.status).toBe(201);
    const workspaceId: string = (createWorkspaceResponse.body as WorkspaceEnvelope).workspace.id;
    expect(typeof workspaceId).toBe('string');
    expect(workspaceId.length).toBeGreaterThan(0);

    // 4. User A can read their own workspace.
    const ownWorkspaceResponse = await request(server)
      .get(`/workspaces/${workspaceId}`)
      .set('Cookie', userACookie);

    expect(ownWorkspaceResponse.status).toBe(200);

    // 5. Register user B.
    const registerBResponse = await request(server).post('/auth/register').send(USER_B);

    expect(registerBResponse.status).toBe(201);
    const userBCookie = toCookieHeader(registerBResponse.get('Set-Cookie'));

    // 6. GET /me as user B — proves B's session is genuinely distinct from A's.
    const meBResponse = await request(server).get('/me').set('Cookie', userBCookie);

    expect(meBResponse.status).toBe(200);
    expect((meBResponse.body as UserEnvelope).user.email).toBe(USER_B.email);

    // 7. User B CANNOT read user A's workspace — the single most important
    // assertion in this task: cross-tenant data access must be rejected.
    const crossTenantResponse = await request(server)
      .get(`/workspaces/${workspaceId}`)
      .set('Cookie', userBCookie);

    expect(crossTenantResponse.status).toBe(403);

    // 8a. No session at all: GET /me is rejected with 401.
    const meNoSessionResponse = await request(server).get('/me');

    expect(meNoSessionResponse.status).toBe(401);

    // 8b. No session at all: GET /workspaces/:id is rejected with 401, not
    // 403 — "no identity" is a different failure mode than "identified but
    // not a member of this workspace".
    const workspaceNoSessionResponse = await request(server).get(`/workspaces/${workspaceId}`);

    expect(workspaceNoSessionResponse.status).toBe(401);

    // 9. Login works independently of register's session (fresh request,
    // does not reuse the cookie register produced).
    const loginAResponse = await request(server).post('/auth/login').send(USER_A);

    expect(loginAResponse.status).toBe(200);
    const loginACookie = toCookieHeader(loginAResponse.get('Set-Cookie'));
    expect(loginACookie).not.toBe('');

    const meAfterLoginResponse = await request(server).get('/me').set('Cookie', loginACookie);

    expect(meAfterLoginResponse.status).toBe(200);
    expect((meAfterLoginResponse.body as UserEnvelope).user.email).toBe(USER_A.email);

    // 10. Wrong password on login is rejected with 401.
    const wrongPasswordResponse = await request(server)
      .post('/auth/login')
      .send({ email: USER_A.email, password: 'definitely-the-wrong-password' });

    expect(wrongPasswordResponse.status).toBe(401);

    // 11. Logout invalidates the session server-side (not just a
    // client-side cookie-clear placebo): the same cookie must be rejected
    // by GET /me immediately after logout.
    const logoutResponse = await request(server).post('/auth/logout').set('Cookie', loginACookie);

    expect(logoutResponse.status).toBe(204);

    const meAfterLogoutResponse = await request(server).get('/me').set('Cookie', loginACookie);

    expect(meAfterLogoutResponse.status).toBe(401);
  }, 60_000);
});
