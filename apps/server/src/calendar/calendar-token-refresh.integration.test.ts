import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockCalendarConnector as MockCalendarConnectorModuleExport } from '@luminaos/integrations';
import { NotFoundError } from '@luminaos/shared';

import { CalendarReconnectRequiredError as CalendarReconnectRequiredErrorModuleExport } from './calendar-reconnect-required.error.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';

import type { CalendarTokenEncryptionService } from './calendar-token-encryption.service.js';
// Type-only, same reasoning as `CalendarTokenEncryptionService` above:
// `calendar-token-refresh.service.js` statically imports
// `calendar-token-encryption.service.js`, which statically imports
// `config/env.js` -- evaluating it before `beforeAll` sets `DATABASE_URL`
// would `process.exit(1)`. The concrete class is loaded via a DYNAMIC import
// inside `beforeAll`, AFTER env vars are set.
import type { CalendarTokenRefreshService as CalendarTokenRefreshServiceClass } from './calendar-token-refresh.service.js';
import type { Database } from '../db/client.js';
import type { INestApplication, Type } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR5b (RED step) -- wiring `packages/integrations`'s
 * `CalendarConnector` into DI (`CALENDAR_CONNECTOR` token/module, mirroring
 * `ai-provider.token.ts`/`ai-provider.module.ts`'s Mock-first pattern
 * EXACTLY, except with no env branch yet -- the factory is a deliberate
 * placeholder that ALWAYS returns `new MockCalendarConnector()`; a future
 * task adds real Google/Outlook adapters behind an env-based branch, exactly
 * like `ai-provider.module.ts`'s own `env.anthropicApiKey` branch), plus a
 * proactive token-refresh flow (`CalendarTokenRefreshService`) that throws a
 * defined `CalendarReconnectRequiredError` (409,
 * `CALENDAR_RECONNECT_REQUIRED`) when the underlying connector's refresh call
 * itself fails.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `calendar/calendar-connector.token.ts` (new) --
 *    `export const CALENDAR_CONNECTOR = 'CALENDAR_CONNECTOR';` -- a
 *    zero-dependency token-only file, mirroring `ai-provider.token.ts`.
 *
 * B. `calendar/calendar-connector.module.ts` (new) -- `CalendarConnectorModule`,
 *    `@Module({ providers: [{ provide: CALENDAR_CONNECTOR, useFactory: () =>
 *    new MockCalendarConnector() }], exports: [CALENDAR_CONNECTOR] })`. No env
 *    branch yet (real adapters are a future, separate task) -- this is a
 *    deliberate placeholder, documented in the module's own header comment.
 *
 * C. `calendar/calendar-reconnect-required.error.ts` (new) --
 *    `CalendarReconnectRequiredError extends AppError`, code
 *    `'CALENDAR_RECONNECT_REQUIRED'`, `statusCode` 409, public readonly
 *    `accountId`/`provider` fields (plain metadata, not a security-sensitive
 *    field -- mirrors `workspace-inconsistency.error.ts`'s local
 *    feature-scoped `AppError` subclass pattern).
 *
 * D. `calendar/calendar-token-refresh.service.ts` (new) --
 *    `@Injectable() CalendarTokenRefreshService`, constructor injects
 *    `DATABASE_CONNECTION`, `CalendarTokenEncryptionService`,
 *    `@Inject(CALENDAR_CONNECTOR) connector: CalendarConnector`.
 *
 *    `ensureFreshAccessToken(accountId: string, workspaceId: string): Promise<string>`
 *    (`workspaceId` added post-security-review, PR5b: defense-in-depth
 *    against a future caller ever forgetting to scope the lookup):
 *      1. SELECT the full row by (id AND workspaceId). No matching row
 *         (nonexistent id, OR id exists but belongs to a DIFFERENT
 *         workspace) -> throw `NotFoundError` (identical for both cases).
 *      2. Decrypt `encryptedAccessToken`.
 *      3. If `row.expiresAt.getTime() > Date.now() + REFRESH_BUFFER_MS`
 *         (module-level const `REFRESH_BUFFER_MS = 5 * 60 * 1000` --
 *         proactive refresh 5 minutes before actual expiry) -> the token is
 *         fresh enough: return the decrypted access token AS-IS, with NO
 *         refresh call and NO DB write (test 1 below pins this "no wasted
 *         network call for a fresh token" behavior).
 *      4. Otherwise (expiring within the buffer OR already expired): decrypt
 *         `encryptedRefreshToken`, build a `CalendarAccount`, call
 *         `connector.refreshToken(account)`.
 *         - SUCCESS: encrypt the new `accessToken`; if `refreshed.refreshToken`
 *           is defined, encrypt+store it too (rotation), ELSE keep the
 *           EXISTING `encryptedRefreshToken` byte-for-byte unchanged (no
 *           overwrite-with-garbage). UPDATE `encryptedAccessToken` /
 *           `encryptedRefreshToken` (conditionally) / `expiresAt` (parsed
 *           from `refreshed.expiresAt`) / `updatedAt`. Return the NEW
 *           decrypted access token.
 *         - FAILURE (connector.refreshToken rejects, for ANY reason): throw
 *           `new CalendarReconnectRequiredError(row.id, row.provider)` --
 *           the raw rejection reason must NOT propagate (it is wrapped), and
 *           NOTHING is written to the DB (stale-but-present tokens survive
 *           untouched for a future manual-reconnect flow).
 *
 * E. `calendar/calendar.module.ts` (modify) -- imports `CalendarConnectorModule`,
 *    adds `CalendarTokenRefreshService` to `providers`.
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: same Testcontainers Postgres 16 + Redis 7 pair,
 * `ENCRYPTION_KEY` env-setup timing (`beforeAll`, BEFORE the dynamic
 * `app.module.js` import), and register/create-workspace/connect-account HTTP
 * helpers as `calendar-accounts.integration.test.ts` (PR5a), duplicated here
 * per this codebase's established self-contained-integration-test
 * convention.
 *
 * Since the REAL `AppModule`'s `CALENDAR_CONNECTOR` always resolves to a bare
 * `new MockCalendarConnector()` with no injected `refreshTokenResponder`, this
 * file uses APPROACH (a) from the task brief -- the idiomatic NestJS
 * `Test.createTestingModule({...}).overrideProvider(CALENDAR_CONNECTOR)
 * .useValue(...)` API (confirmed against this repo's own precedent at
 * `../objects/object-recurrence-trigger.integration.test.ts`, which overrides
 * `TaskRecurrenceService` the identical way) -- to inject a
 * `MockCalendarConnector` configured with a `refreshTokenResponder` that
 * forwards to a mutable module-level `currentResponder` closure variable.
 * Each `it` reassigns `currentResponder` before calling
 * `ensureFreshAccessToken`, letting a SINGLE app boot (cheap -- one
 * Testcontainers pair for the whole file) serve every success/failure
 * scenario without re-booting Nest per test. Test 6 (DI placeholder
 * sanity-check) is the one exception: it boots a SECOND, override-free
 * `Test.createTestingModule` against the SAME already-running containers, to
 * prove the real (non-overridden) production wiring resolves to
 * `MockCalendarConnector`.
 *
 * LINT NOTE (mirrors `../recurrence/task-recurrence.service.test.ts`'s own
 * note): `./calendar-token-refresh.service.ts` and
 * `./calendar-reconnect-required.error.ts` don't exist yet, and
 * `@luminaos/integrations` is not yet declared as an `apps/server`
 * dependency, so all three named exports above resolve to `any`, which would
 * otherwise cascade `@typescript-eslint/no-unsafe-*` errors through every
 * line touching them, on top of the three genuinely-expected
 * `import-x/no-unresolved` errors this file is supposed to fail with. The
 * local `*Like`/`*Instance`/`*Constructor` interfaces + `as unknown as ...`
 * casts just below the imports are the narrow escape hatch (mirrors
 * `db/client.ts`'s `as unknown as Pool['query']` pattern) -- once the real
 * modules/dependency exist with these exact shapes, the casts become no-ops
 * and can be deleted in favor of importing the real types directly.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of `calendar-connector.token.ts`,
 * `calendar-connector.module.ts`, `calendar-reconnect-required.error.ts`, or
 * `calendar-token-refresh.service.ts` exist yet, `@luminaos/integrations` is
 * not yet an `apps/server` dependency, and `calendar.module.ts` does not
 * provide `CalendarTokenRefreshService`. Concretely, THIS FILE FAILS TO
 * COMPILE/RESOLVE (Vitest/tsc reports "Cannot find module" for
 * `./calendar-token-refresh.service.js`, `./calendar-reconnect-required.error.js`,
 * and `@luminaos/integrations`) -- this is the correct red: the wiring this
 * PR adds simply does not exist yet, not a test-logic bug.
 * ============================================================================
 */

interface CalendarAccountLike {
  id: string;
  provider: 'google' | 'outlook';
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface RefreshedTokensLike {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

interface MockCalendarConnectorOptionsLike {
  refreshTokenResponder?: (
    account: CalendarAccountLike,
  ) => RefreshedTokensLike | Promise<RefreshedTokensLike>;
}

interface MockCalendarConnectorConstructor {
  new (options?: MockCalendarConnectorOptionsLike): object;
}

const MockCalendarConnector =
  MockCalendarConnectorModuleExport as unknown as MockCalendarConnectorConstructor;

interface CalendarReconnectRequiredErrorInstance {
  statusCode: number;
  code: string;
  accountId: string;
  provider: string;
}

interface CalendarReconnectRequiredErrorConstructor {
  new (accountId: string, provider: string): CalendarReconnectRequiredErrorInstance;
}

const CalendarReconnectRequiredError =
  CalendarReconnectRequiredErrorModuleExport as unknown as CalendarReconnectRequiredErrorConstructor;

// Deliberately hardcoded rather than imported from the (not-yet-existing)
// `calendar-connector.token.ts` -- the override call below needs the exact
// runtime string value the real `CalendarConnectorModule` will register
// under, so this constant MUST stay byte-for-byte identical to contract §A.
const CALENDAR_CONNECTOR = 'CALENDAR_CONNECTOR';

type CalendarAccountRow = typeof calendarAccounts.$inferSelect;

const PASSWORD = 'correct-horse-battery-staple';

interface CalendarAccountBody {
  id: string;
  provider: string;
  expiresAt: string;
}

interface CalendarAccountEnvelope {
  account: CalendarAccountBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `calendar-token-refresh-test-user-${String(emailCounter)}@example.com`;
}

/**
 * Forwarded to by the single `MockCalendarConnector` instance the whole app
 * is booted with -- reassigned by each `it` immediately before calling
 * `ensureFreshAccessToken`, so different tests can script different
 * success/failure refresh behavior without re-booting Nest.
 */
let currentResponder: (account: CalendarAccountLike) => Promise<RefreshedTokensLike> = () =>
  Promise.reject(new Error('currentResponder not configured for this test'));

describe('F1-T12 PR5b (RED step): CalendarConnector DI wiring + proactive CalendarTokenRefreshService (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let tokenEncryption: CalendarTokenEncryptionService;
  let CalendarTokenRefreshService: Type<CalendarTokenRefreshServiceClass>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');

    await runMigrations(container.getConnectionUri());

    // Imported only after env vars are set, per the established convention
    // in every other integration test file here.
    const { AppModule } = await import('../app.module.js');
    const encryptionModule = await import('./calendar-token-encryption.service.js');
    const refreshModule = await import('./calendar-token-refresh.service.js');
    CalendarTokenRefreshService = refreshModule.CalendarTokenRefreshService;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CALENDAR_CONNECTOR)
      .useValue(
        new MockCalendarConnector({
          refreshTokenResponder: (account) => currentResponder(account),
        }),
      )
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
    tokenEncryption = new encryptionModule.CalendarTokenEncryptionService();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    expect((registerResponse.body as UserEnvelope).user.id).toBeDefined();

    const workspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Calendar refresh test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function connectAccount(cookie: string, workspaceId: string): Promise<CalendarAccountBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/calendar/accounts`)
      .set('Cookie', cookie)
      .send({ provider: 'google' });
    expect(response.status).toBe(201);
    return (response.body as CalendarAccountEnvelope).account;
  }

  async function rawRow(accountId: string): Promise<CalendarAccountRow> {
    const rows = await rawDb
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.id, accountId));
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Expected a calendar_accounts row for id ${accountId}`);
    }
    return row;
  }

  async function expireAccount(accountId: string): Promise<void> {
    await rawDb
      .update(calendarAccounts)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(calendarAccounts.id, accountId));
  }

  it('1. fresh token (expiresAt ~1h out, well beyond the 5-minute buffer): ensureFreshAccessToken returns the current token and does NOT mutate the row (no wasted refresh call)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const before = await rawRow(account.id);

    const service = app.get(CalendarTokenRefreshService);
    const accessToken = await service.ensureFreshAccessToken(account.id, workspaceId);

    expect(typeof accessToken).toBe('string');
    expect(accessToken.length).toBeGreaterThan(0);

    const after = await rawRow(account.id);
    expect(after.encryptedAccessToken).toBe(before.encryptedAccessToken);
    expect(after.encryptedRefreshToken).toBe(before.encryptedRefreshToken);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('2. expired token, successful refresh WITHOUT rotation: access token + expiresAt update, refresh token stays byte-for-byte unchanged', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);
    await expireAccount(account.id);

    const before = await rawRow(account.id);
    const newExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

    currentResponder = () =>
      Promise.resolve({
        accessToken: 'new-access-token',
        expiresAt: newExpiresAt,
      });

    const service = app.get(CalendarTokenRefreshService);
    const returnedToken = await service.ensureFreshAccessToken(account.id, workspaceId);
    expect(returnedToken).toBe('new-access-token');

    const after = await rawRow(account.id);
    expect(after.encryptedAccessToken).not.toBe(before.encryptedAccessToken);
    expect(tokenEncryption.decrypt(after.encryptedAccessToken)).toBe('new-access-token');
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(after.encryptedRefreshToken).toBe(before.encryptedRefreshToken);
  });

  it('3. expired token, successful refresh WITH refresh-token rotation: both access and refresh tokens update', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);
    await expireAccount(account.id);

    const before = await rawRow(account.id);
    const newExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

    currentResponder = () =>
      Promise.resolve({
        accessToken: 'rotated-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: newExpiresAt,
      });

    const service = app.get(CalendarTokenRefreshService);
    const returnedToken = await service.ensureFreshAccessToken(account.id, workspaceId);
    expect(returnedToken).toBe('rotated-access-token');

    const after = await rawRow(account.id);
    expect(after.encryptedAccessToken).not.toBe(before.encryptedAccessToken);
    expect(tokenEncryption.decrypt(after.encryptedAccessToken)).toBe('rotated-access-token');
    expect(after.encryptedRefreshToken).not.toBe(before.encryptedRefreshToken);
    expect(tokenEncryption.decrypt(after.encryptedRefreshToken)).toBe('new-refresh-token');
  });

  it('4. expired token, refresh FAILS: rejects with CalendarReconnectRequiredError (409, CALENDAR_RECONNECT_REQUIRED, matching accountId/provider), row left untouched', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);
    await expireAccount(account.id);

    const before = await rawRow(account.id);

    currentResponder = () => Promise.reject(new Error('mock provider rejected refresh'));

    const service = app.get(CalendarTokenRefreshService);

    let caught: unknown;
    try {
      await service.ensureFreshAccessToken(account.id, workspaceId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CalendarReconnectRequiredError);
    const typedError = caught as CalendarReconnectRequiredErrorInstance;
    expect(typedError.statusCode).toBe(409);
    expect(typedError.code).toBe('CALENDAR_RECONNECT_REQUIRED');
    expect(typedError.accountId).toBe(account.id);
    expect(typedError.provider).toBe('google');

    const after = await rawRow(account.id);
    expect(after.encryptedAccessToken).toBe(before.encryptedAccessToken);
    expect(after.encryptedRefreshToken).toBe(before.encryptedRefreshToken);
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('5. nonexistent account id: ensureFreshAccessToken rejects with NotFoundError', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const randomUuid = '00000000-0000-4000-8000-000000000099';

    const service = app.get(CalendarTokenRefreshService);

    await expect(service.ensureFreshAccessToken(randomUuid, workspaceId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('5b. cross-tenant: an account belonging to a DIFFERENT workspace is rejected identically to nonexistent (security fix, PR5b review)', async () => {
    const owner = await registerOwnerWithWorkspace();
    const account = await connectAccount(owner.cookie, owner.workspaceId);
    const { workspaceId: otherWorkspaceId } = await registerOwnerWithWorkspace();

    const service = app.get(CalendarTokenRefreshService);

    await expect(
      service.ensureFreshAccessToken(account.id, otherWorkspaceId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('6. CALENDAR_CONNECTOR resolves to a MockCalendarConnector by default (no override) -- proves the placeholder factory wiring end-to-end', async () => {
    const { AppModule } = await import('../app.module.js');

    const unoverriddenModuleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const unoverriddenApp = unoverriddenModuleRef.createNestApplication();
    await unoverriddenApp.init();

    try {
      const connector = unoverriddenApp.get<unknown>(CALENDAR_CONNECTOR);
      expect(connector).toBeInstanceOf(MockCalendarConnector);
    } finally {
      await unoverriddenApp.close();
    }
  }, 30_000);
});
