import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR5a (RED step) — "connect a calendar account via mock OAuth" +
 * encrypted-at-rest token storage. Per ADR-0012 §c and the approved plan,
 * this PR is ONLY the connect/list/disconnect flow — NOT token refresh, NOT
 * polling, NOT timeblock push (PR5b/PR5c). Mirrors
 * `../workspaces/workspaces.integration.test.ts`'s Testcontainers harness
 * (Postgres 16 + Redis 7, `runMigrations`, dynamic `import('../app.module.js')`
 * AFTER env vars are set, `Test.createTestingModule`, supertest) and
 * `../objects/timeblock-projection.integration.test.ts`'s raw-row helper
 * pattern (`createDatabaseClient` + a raw `pg` query, deliberately NOT
 * Drizzle's typed schema object, so this file type-checks cleanly today and
 * simply starts returning real data once the implementation lands — a typed
 * `calendarAccounts.encryptedAccessToken` reference would fail
 * `pnpm typecheck` until `db/schema/calendar-accounts.ts` exists).
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `apps/server/src/config/env.ts` — new optional `encryptionKey?: Buffer`
 *    field, sourced from `ENCRYPTION_KEY` (base64, must decode to exactly 32
 *    bytes). See `./env-calendar.test.ts` for the full reader contract. This
 *    file sets `process.env['ENCRYPTION_KEY']` to a valid 32-byte base64
 *    string in `beforeAll`, BEFORE the dynamic `app.module.js` import — no
 *    existing integration test sets this var today.
 *
 * B. `db/schema/calendar-accounts.ts` (new) + migration (up+down): a
 *    `calendar_accounts` table —
 *      id, workspace_id (FK->workspaces, cascade), user_id (FK->users,
 *      cascade), provider ('google'|'outlook'), encrypted_access_token
 *      (text), encrypted_refresh_token (text), expires_at (timestamptz),
 *      created_at, updated_at.
 *
 * C. `calendar/calendar-token-encryption.service.ts` (new) —
 *    `CalendarTokenEncryptionService.encrypt`/`.decrypt`, wrapping
 *    `@luminaos/shared`'s `encryptSecret`/`decryptSecret` (AES-256-GCM) with
 *    `env.encryptionKey`. Packed ciphertext format is `iv:authTag:ciphertext`
 *    (three `:`-delimited base64 segments) — see test #5 below.
 *
 * D. `calendar/dto/connect-calendar-account.schema.ts` (new) — zod
 *    `{ provider: z.enum(['google','outlook']) }.strict()`.
 *
 * E. `calendar/calendar-accounts.service.ts` (new) — `CalendarAccountsService`:
 *      - `connect(workspaceId, userId, provider)`: simulates the mock OAuth
 *        handshake completing synchronously — generates synthetic tokens,
 *        encrypts both, inserts a row, returns ONLY
 *        `{id, provider, expiresAt}` — NEVER any token field, encrypted or
 *        not, in the returned/response shape.
 *      - `list(workspaceId)`: metadata only, same no-token-leakage rule.
 *      - `disconnect(workspaceId, accountId)`: deletes the row scoped to
 *        `workspaceId`; throws `NotFoundError` (404) if the row doesn't
 *        exist OR belongs to a different workspace — cross-tenant deletion
 *        attempts get an IDENTICAL not-found response, never a distinguishing
 *        error.
 *
 * F. `calendar/calendar-accounts.controller.ts` (new) — mirrors
 *    `../workspaces/workspaces.controller.ts`'s guard/param/fail-closed
 *    conventions exactly:
 *      - `POST /workspaces/:workspaceId/calendar/accounts` ->
 *        `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)`,
 *        `@UsePipes(new ZodValidationPipe(connectCalendarAccountSchema))`,
 *        201, body `{ account: {id, provider, expiresAt} }`.
 *      - `GET /workspaces/:workspaceId/calendar/accounts` -> same guards,
 *        200, `{ accounts: [...] }`.
 *      - `DELETE /workspaces/:workspaceId/calendar/accounts/:accountId` ->
 *        same guards + `ParseUUIDPipe` on `accountId`, 204.
 *
 * G. `calendar/calendar.module.ts` (new), wired into `app.module.ts`'s
 *    `imports` array.
 *
 * SECURITY INVARIANT PINNED THROUGHOUT: no HTTP response body for ANY route
 * in this file may ever contain a field named/matching
 * `accessToken`/`refreshToken`/`encryptedAccessToken`/`encryptedRefreshToken`
 * — enforced below via a `JSON.stringify(response.body)` regex guard against
 * `/token/i` on every connect/list assertion.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `CalendarModule` does not exist and is not
 * imported into `AppModule`, so EVERY route this file hits
 * (`/workspaces/:workspaceId/calendar/accounts...`) 404s as an unmatched
 * route (Nest's default "Cannot POST/GET/DELETE ..." 404), including the
 * unauthenticated/non-member cases (tests 11/12) which expect 401/403 but
 * will actually also see 404 today (no route to even apply guards to) — this
 * is expected and will resolve to the real 401/403 once `CalendarModule` and
 * its guards exist. The raw-row test (test 5) fails differently: the
 * `rawDb.$client.query(...)` call itself REJECTS with a real Postgres error
 * (`relation "calendar_accounts" does not exist`), since the migration
 * doesn't exist yet.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface CalendarAccountBody {
  id: string;
  provider: string;
  expiresAt: string;
}

interface CalendarAccountEnvelope {
  account: CalendarAccountBody;
}

interface CalendarAccountListEnvelope {
  accounts: CalendarAccountBody[];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface RawCalendarAccountRow {
  encrypted_access_token: string;
  encrypted_refresh_token: string;
}

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim per established convention). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `calendar-accounts-test-user-${String(emailCounter)}@example.com`;
}

/** Strong leakage guard: the ENTIRE response body, serialized, must never
 * contain anything matching `/token/i` (case-insensitive) — catches
 * `accessToken`, `refreshToken`, `encryptedAccessToken`,
 * `encryptedRefreshToken`, or any future differently-cased token field. */
function assertNoTokenLeak(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/token/i);
}

describe('F1-T12 PR5a (RED step): connect/list/disconnect calendar accounts via mock OAuth, encrypted-at-rest token storage (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Required by this PR's contract (§A) -- absent in every OTHER
    // integration test file. A valid 32-byte AES-256 key, base64-encoded.
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');

    await runMigrations(container.getConnectionUri());

    // Imported only after env vars are set, per the established convention
    // in every other integration test file here.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
  }

  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Calendar test workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  function accountsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/calendar/accounts`;
  }

  async function connectAccount(
    cookie: string,
    workspaceId: string,
    provider: 'google' | 'outlook',
  ): Promise<CalendarAccountBody> {
    const response = await request(server)
      .post(accountsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ provider });

    expect(response.status).toBe(201);
    return (response.body as CalendarAccountEnvelope).account;
  }

  it('1. POST .../calendar/accounts with {provider: "google"} -> 201, returns {account:{id,provider,expiresAt}}, no token fields leaked', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(accountsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ provider: 'google' });

    expect(response.status).toBe(201);
    const { account } = response.body as CalendarAccountEnvelope;
    expect(account.id).toBeDefined();
    expect(account.provider).toBe('google');
    expect(account.expiresAt).toBeDefined();
    assertNoTokenLeak(response.body);
  });

  it('2. POST .../calendar/accounts with {provider: "outlook"} -> 201, returns {account:{id,provider,expiresAt}}, no token fields leaked', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(accountsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ provider: 'outlook' });

    expect(response.status).toBe(201);
    const { account } = response.body as CalendarAccountEnvelope;
    expect(account.id).toBeDefined();
    expect(account.provider).toBe('outlook');
    expect(account.expiresAt).toBeDefined();
    assertNoTokenLeak(response.body);
  });

  it('3. POST .../calendar/accounts with an invalid provider ("yahoo") -> 400 (zod rejection)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(accountsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ provider: 'yahoo' });

    expect(response.status).toBe(400);
  });

  it('4. POST .../calendar/accounts with a missing "provider" field -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(accountsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({});

    expect(response.status).toBe(400);
  });

  it('5. raw-row encryption proof: encrypted_access_token/encrypted_refresh_token are non-empty and packed as iv:authTag:ciphertext (real encryption, not stored raw)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId, 'google');

    const result = await rawDb.$client.query<RawCalendarAccountRow>(
      'select encrypted_access_token, encrypted_refresh_token from calendar_accounts where id = $1',
      [account.id],
    );

    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row?.encrypted_access_token.length).toBeGreaterThan(0);
    expect(row?.encrypted_refresh_token.length).toBeGreaterThan(0);

    // `encryptSecret`'s packed format is `iv:authTag:ciphertext` -- exactly
    // two `:` characters proves it went through real encryption rather than
    // being persisted as plaintext (which would have zero, or an
    // unpredictable number of, `:` characters).
    expect((row?.encrypted_access_token.match(/:/g) ?? []).length).toBe(2);
    expect((row?.encrypted_refresh_token.match(/:/g) ?? []).length).toBe(2);
  });

  it('6. GET .../calendar/accounts after connecting google+outlook -> 200, both present, no token fields leaked', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId, 'google');
    await connectAccount(cookie, workspaceId, 'outlook');

    const response = await request(server).get(accountsUrl(workspaceId)).set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { accounts } = response.body as CalendarAccountListEnvelope;
    const providers = accounts.map((a) => a.provider);
    expect(providers).toContain('google');
    expect(providers).toContain('outlook');
    assertNoTokenLeak(response.body);
  });

  it('7. GET .../calendar/accounts with no accounts connected -> 200, accounts: []', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server).get(accountsUrl(workspaceId)).set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect((response.body as CalendarAccountListEnvelope).accounts).toEqual([]);
  });

  it('8. DELETE .../calendar/accounts/:accountId for an owned account -> 204, subsequent GET no longer lists it', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId, 'google');

    const deleteResponse = await request(server)
      .delete(`${accountsUrl(workspaceId)}/${account.id}`)
      .set('Cookie', cookie);

    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(server).get(accountsUrl(workspaceId)).set('Cookie', cookie);
    const ids = (listResponse.body as CalendarAccountListEnvelope).accounts.map((a) => a.id);
    expect(ids).not.toContain(account.id);
  });

  it('9. DELETE .../calendar/accounts/:accountId for an account belonging to a DIFFERENT workspace -> 404 (identical not-found, not 403)', async () => {
    const ownerA = await registerOwnerWithWorkspace();
    const accountA = await connectAccount(ownerA.cookie, ownerA.workspaceId, 'google');

    const ownerB = await registerOwnerWithWorkspace();

    const response = await request(server)
      .delete(`${accountsUrl(ownerB.workspaceId)}/${accountA.id}`)
      .set('Cookie', ownerB.cookie);

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(200);
    expect(response.status).not.toBe(204);
  });

  it('10. DELETE .../calendar/accounts/:accountId for a nonexistent (random UUID) account -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const randomUuid = '00000000-0000-4000-8000-000000000000';

    const response = await request(server)
      .delete(`${accountsUrl(workspaceId)}/${randomUuid}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it('11. unauthenticated requests (no session cookie) to all three routes -> 401', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const randomUuid = '00000000-0000-4000-8000-000000000001';

    const postResponse = await request(server)
      .post(accountsUrl(workspaceId))
      .send({ provider: 'google' });
    expect(postResponse.status).toBe(401);

    const getResponse = await request(server).get(accountsUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const deleteResponse = await request(server).delete(
      `${accountsUrl(workspaceId)}/${randomUuid}`,
    );
    expect(deleteResponse.status).toBe(401);
  });

  it('12. a user authenticated but NOT a member of the target workspace -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: outsiderCookie } = await registerUser();
    const randomUuid = '00000000-0000-4000-8000-000000000002';

    const postResponse = await request(server)
      .post(accountsUrl(workspaceId))
      .set('Cookie', outsiderCookie)
      .send({ provider: 'google' });
    expect(postResponse.status).toBe(403);

    const getResponse = await request(server)
      .get(accountsUrl(workspaceId))
      .set('Cookie', outsiderCookie);
    expect(getResponse.status).toBe(403);

    const deleteResponse = await request(server)
      .delete(`${accountsUrl(workspaceId)}/${randomUuid}`)
      .set('Cookie', outsiderCookie);
    expect(deleteResponse.status).toBe(403);
  });
});
