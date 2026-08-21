import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CalendarAccount,
  CalendarConnector,
  ExternalCalendarEvent,
  RefreshedTokens,
} from '@luminaos/integrations';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR5c (RED step, part 1 of 2) -- periodic polling of external
 * calendar events into a read-only, disposable cache table
 * (`calendar_events_cache`), per ADR-0012 §a ("external events are NEVER
 * event-sourced -- they are a read-only cache refreshed by periodic
 * polling"). This file pins the SCHEMA + POLLER half of the contract; the
 * GET-route (read) half is pinned by the sibling file
 * `calendar-events.integration.test.ts`.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `db/schema/calendar-events-cache.ts` (new) -- `calendarEventsCache`
 *    table: `id` (uuid pk, `gen_random_uuid()`), `calendarAccountId` (uuid,
 *    FK -> `calendarAccounts.id`, cascade), `workspaceId` (uuid, FK ->
 *    `workspaces.id`, cascade), `externalId` (text), `title` (text),
 *    `eventStart`/`eventEnd` (timestamptz -- NOT `start`/`end`, mirroring
 *    `objects-view.ts`'s `timeBlockStart`/`timeBlockEnd` reserved-word-avoidance
 *    precedent), `updatedAt` (timestamptz, `defaultNow()`), plus a unique
 *    index on `(calendarAccountId, externalId)` enabling the upsert in §C.
 *    Plus an up+down migration (CLAUDE.md: never a migration without a down
 *    script).
 *
 * B. `calendar/calendar-sync-poller.service.ts` (new) -- `@Injectable()
 *    CalendarSyncPollerService implements OnModuleInit, OnModuleDestroy`,
 *    injecting `DATABASE_CONNECTION`, `CalendarTokenRefreshService`, and
 *    `@Inject(CALENDAR_CONNECTOR) connector`. Module consts:
 *    `SYNC_WINDOW_MS = 30 days`, `POLL_INTERVAL_MS = 5 minutes`.
 *      - `onModuleInit()`: starts a `setInterval(() => void this.pollOnce(),
 *        POLL_INTERVAL_MS)`.
 *      - `onModuleDestroy()`: `clearInterval`s that handle -- this is the
 *        FIRST scheduling-adjacent service in this codebase with proper
 *        interval cleanup (unlike `AIRefreshScheduler`'s documented gap, see
 *        test 5 below).
 *      - `async pollOnce(): Promise<void>` (directly callable by tests,
 *        never via the real 5-minute interval):
 *          1. SELECT all `calendarAccounts` rows (id, workspaceId, provider).
 *          2. For EACH account, independently, wrapped in its own try/catch
 *             (one account's failure must never abort another's):
 *             a. `ensureFreshAccessToken(account.id, account.workspaceId)` --
 *                throws (e.g. `CalendarReconnectRequiredError`) -> skip this
 *                account, no cache writes this cycle.
 *             b. `connector.listEvents({start: now, end: now+SYNC_WINDOW_MS})`
 *                -- throws -> also skip this account.
 *             c. UPSERT each returned event into `calendarEventsCache` keyed
 *                by `(calendarAccountId, externalId)`: on conflict, update
 *                `title`/`eventStart`/`eventEnd`/`updatedAt`; otherwise
 *                insert a full new row.
 *          3. Does NOT prune/delete cache rows for events that stopped
 *             appearing in `listEvents` (documented future work, out of
 *             scope here).
 *
 * C. `calendar/calendar.module.ts` (modify) -- adds `CalendarSyncPollerService`
 *    (and `CalendarEventsService`/`CalendarEventsController`, pinned by the
 *    sibling test file) to the module.
 *
 * ----------------------------------------------------------------------------
 * KNOWN, DOCUMENTED ARCHITECTURAL SIMPLIFICATION (not a bug): PR4's
 * `CalendarConnector.listEvents(range)` takes no per-account parameter -- it
 * models a SINGLE authenticated connection, not a multi-tenant client. Since
 * the only connector today (`MockCalendarConnector`, and this file's own
 * `ScriptedCalendarConnector` stand-in) is stateless with respect to which
 * account is asking, `pollOnce()` calls the SAME connector instance once per
 * connected account and tags whatever it returns with THAT account's
 * id/workspaceId. A future real-adapter task must model per-account
 * authenticated client construction properly; that's out of scope here, and
 * this file's tests are deliberately scoped (via distinct/expired accounts,
 * or by asserting only on the specific account each `it` cares about) to
 * avoid being confused by two accounts legitimately receiving the same
 * connector response within a single `pollOnce()` cycle.
 *
 * HARNESS NOTE: same Testcontainers Postgres 16 + Redis 7 pair,
 * `ENCRYPTION_KEY` env-setup timing, and register/create-workspace/connect-
 * account HTTP helpers as `calendar-accounts.integration.test.ts` /
 * `calendar-token-refresh.integration.test.ts`, duplicated here per this
 * codebase's established self-contained-integration-test convention. A
 * SINGLE app boot serves the whole file (cheap -- one Testcontainers pair),
 * with `CALENDAR_CONNECTOR` overridden by a custom `ScriptedCalendarConnector`
 * (rather than `MockCalendarConnector`, whose `events` list is fixed at
 * construction time) whose `events`/`listEventsError`/`refreshTokenResponder`
 * fields are mutable and reset in a `beforeEach`, mirroring PR5b's
 * `currentResponder` mutable-closure technique, generalized to a small stub
 * class since this file needs to reconfigure `listEvents` behavior
 * mid-suite, not just `refreshToken`.
 *
 * Because every `it` in this file shares one app/DB, and `pollOnce()`
 * processes ALL `calendar_accounts` rows that exist at call time (including
 * ones created by earlier tests), every assertion below is scoped to the
 * specific account(s) each test created -- never to "the cache table as a
 * whole" -- so earlier/later tests' accounts being reprocessed on subsequent
 * `pollOnce()` calls cannot make an assertion spuriously pass or fail.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./calendar-sync-poller.service.ts` does not
 * exist, so the dynamic `import('./calendar-sync-poller.service.js')` inside
 * `beforeAll` REJECTS ("Cannot find module"), failing `beforeAll` and thus
 * every `it` in this file -- the correct red: the poller this PR adds simply
 * does not exist yet, not a test-logic bug. Once that file exists but before
 * `db/schema/calendar-events-cache.ts` + its migration exist, the failure
 * mode shifts to `pollOnce()`'s raw SQL upserts (and this file's raw
 * verification queries) rejecting with a real Postgres error (`relation
 * "calendar_events_cache" does not exist`).
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

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface RawCachedEventRow {
  id: string;
  calendar_account_id: string;
  workspace_id: string;
  external_id: string;
  title: string;
  event_start: Date;
  event_end: Date;
  updated_at: Date;
  meeting_url: string | null;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `calendar-sync-poller-test-user-${String(emailCounter)}@example.com`;
}

function defaultRefreshTokenResponder(): Promise<RefreshedTokens> {
  return Promise.resolve({
    accessToken: 'scripted-refreshed-access-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/**
 * `calendar-sync-poller.service.ts` doesn't exist yet, so a `type`-only
 * import of `CalendarSyncPollerService` would resolve to `any`, cascading
 * `@typescript-eslint/no-unsafe-*` errors through every line touching it
 * (`app.get(...)`, `poller.pollOnce()`, ...) on top of the one genuinely-
 * expected `import-x/no-unresolved` error this file is supposed to fail
 * with. This narrow `*Like`/`*Constructor` escape hatch (mirrors
 * `calendar-token-refresh.integration.test.ts`'s identical technique for
 * `MockCalendarConnector`/`CalendarReconnectRequiredError`) contains the
 * `any` to a single cast, just below the dynamic import; once the real
 * module exists with this shape, the cast becomes a no-op and can be
 * deleted in favor of importing the real type directly.
 */
interface CalendarSyncPollerServiceLike {
  pollOnce(): Promise<void>;
}

interface CalendarSyncPollerServiceConstructor {
  new (...args: unknown[]): CalendarSyncPollerServiceLike;
}

/**
 * A mutable-state `CalendarConnector` test double, distinct from
 * `MockCalendarConnector` (whose `events` are fixed at construction) so this
 * file can reconfigure `listEvents`'s response and error behavior between
 * `pollOnce()` calls within the SAME `it`, and reset it in `beforeEach`
 * between `it`s. `createEvent`/`updateEvent`/`deleteEvent` are not exercised
 * by this PR's poller and are deliberately omitted from the parameter list
 * (still structurally satisfies `CalendarConnector`) -- they simply reject if
 * ever accidentally called.
 */
class ScriptedCalendarConnector implements CalendarConnector {
  events: ExternalCalendarEvent[] = [];
  listEventsError: Error | undefined = undefined;
  refreshTokenResponder: (account: CalendarAccount) => Promise<RefreshedTokens> =
    defaultRefreshTokenResponder;

  listEvents(): Promise<ExternalCalendarEvent[]> {
    if (this.listEventsError !== undefined) {
      return Promise.reject(this.listEventsError);
    }
    return Promise.resolve(this.events);
  }

  createEvent(): Promise<{ externalId: string }> {
    return Promise.reject(
      new Error('ScriptedCalendarConnector.createEvent is not used by this test file'),
    );
  }

  updateEvent(): Promise<void> {
    return Promise.reject(
      new Error('ScriptedCalendarConnector.updateEvent is not used by this test file'),
    );
  }

  deleteEvent(): Promise<void> {
    return Promise.reject(
      new Error('ScriptedCalendarConnector.deleteEvent is not used by this test file'),
    );
  }

  refreshToken(account: CalendarAccount): Promise<RefreshedTokens> {
    return this.refreshTokenResponder(account);
  }
}

describe('F1-T12 PR5c (RED step): CalendarSyncPollerService -- periodic external-calendar polling into a read-only cache (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let connector: ScriptedCalendarConnector;
  let CalendarSyncPollerService: CalendarSyncPollerServiceConstructor;

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
    const pollerModule = (await import('./calendar-sync-poller.service.js')) as unknown as {
      CalendarSyncPollerService: CalendarSyncPollerServiceConstructor;
    };
    CalendarSyncPollerService = pollerModule.CalendarSyncPollerService;

    connector = new ScriptedCalendarConnector();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CALENDAR_CONNECTOR)
      .useValue(connector)
      .compile();

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

  beforeEach(() => {
    connector.events = [];
    connector.listEventsError = undefined;
    connector.refreshTokenResponder = defaultRefreshTokenResponder;
  });

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
      .send({ name: `Calendar sync poller test workspace ${String(emailCounter)}` });
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

  async function expireAccount(accountId: string): Promise<void> {
    await rawDb
      .update(calendarAccounts)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(calendarAccounts.id, accountId));
  }

  async function rawCachedEventsForAccount(accountId: string): Promise<RawCachedEventRow[]> {
    const result = await rawDb.$client.query<RawCachedEventRow>(
      'select id, calendar_account_id, workspace_id, external_id, title, event_start, event_end, updated_at, meeting_url from calendar_events_cache where calendar_account_id = $1 order by external_id',
      [accountId],
    );
    return result.rows;
  }

  it('1. basic poll caches events: pollOnce() upserts a connector-returned event into calendar_events_cache, tagged to the correct account/workspace', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      { externalId: 'ext-1', title: 'Standup', start: eventStart, end: eventEnd },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    const rows = await rawCachedEventsForAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace_id).toBe(workspaceId);
    expect(rows[0]?.external_id).toBe('ext-1');
    expect(rows[0]?.title).toBe('Standup');
    expect(rows[0]?.event_start.toISOString()).toBe(eventStart);
    expect(rows[0]?.event_end.toISOString()).toBe(eventEnd);
  });

  it('2. re-poll upserts (updates in place, does not duplicate): a second pollOnce() with a changed title for the same externalId leaves exactly one row, with the latest title', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      { externalId: 'ext-2', title: 'Original title', start: eventStart, end: eventEnd },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    connector.events = [
      { externalId: 'ext-2', title: 'Updated title', start: eventStart, end: eventEnd },
    ];
    await poller.pollOnce();

    const rows = await rawCachedEventsForAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Updated title');
  });

  it('3. an account needing reconnect is skipped, but a healthy account is still processed in the same poll cycle', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const healthyAccount = await connectAccount(cookie, workspaceId);
    const expiredAccount = await connectAccount(cookie, workspaceId);
    await expireAccount(expiredAccount.id);

    connector.events = [
      {
        externalId: 'ext-3',
        title: 'Only the healthy account should get this',
        start: new Date(Date.now() + 3_600_000).toISOString(),
        end: new Date(Date.now() + 7_200_000).toISOString(),
      },
    ];
    connector.refreshTokenResponder = () =>
      Promise.reject(new Error('scripted refresh failure for the expired account'));

    const poller = app.get(CalendarSyncPollerService);
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    const healthyRows = await rawCachedEventsForAccount(healthyAccount.id);
    expect(healthyRows).toHaveLength(1);
    expect(healthyRows[0]?.external_id).toBe('ext-3');

    const expiredRows = await rawCachedEventsForAccount(expiredAccount.id);
    expect(expiredRows).toHaveLength(0);
  });

  it('4. listEvents() throwing for an account does not crash the whole poll cycle -- pollOnce() still resolves', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);

    connector.listEventsError = new Error('scripted listEvents failure');

    const poller = app.get(CalendarSyncPollerService);
    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });

  it('5. onModuleDestroy() clears the polling interval (unlike AIRefreshScheduler, this is the first scheduling-adjacent service with proper interval cleanup)', async () => {
    const { AppModule } = await import('../app.module.js');

    const secondModuleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CALENDAR_CONNECTOR)
      .useValue(new ScriptedCalendarConnector())
      .compile();

    const secondApp = secondModuleRef.createNestApplication();
    await secondApp.init();

    // Force-resolve the poller so we know `onModuleInit` (and thus the
    // `setInterval`) has definitely run before we assert on cleanup.
    secondApp.get(CalendarSyncPollerService);

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    try {
      await secondApp.close();
      // A weaker, deliberately-documented proxy for "the interval handle
      // this service created was cleared": rather than reaching into a
      // private field, we assert Nest's `onModuleDestroy` lifecycle actually
      // triggered SOME `clearInterval` call during shutdown -- which the
      // pinned contract requires `CalendarSyncPollerService.onModuleDestroy`
      // to be the source of, since no other provider in this app registers
      // an interval. If this ever becomes ambiguous (another service starts
      // its own interval), the stronger fallback is `secondApp.close()`
      // itself resolving promptly, which it must either way.
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  }, 30_000);

  /**
   * F2-T13 PR2 (RED step) additions -- `ExternalCalendarEvent.meetingUrl`
   * (optional) must flow through `pollOnce()`'s insert/`onConflictDoUpdate`
   * into `calendar_events_cache.meeting_url` (nullable text column, new
   * migration after 0030). See the sibling `calendar-connector.test.ts` and
   * `calendar-events.integration.test.ts` for the rest of this PR's pinned
   * contract.
   *
   * EXPECTED RED STATE (today): `ExternalCalendarEvent` has no `meetingUrl`
   * field, so the object literals below (`{ ..., meetingUrl: '...' }`) fail
   * to typecheck (excess property on a non-existent field) -- once that
   * lands, `calendar_events_cache` has no `meeting_url` column, so
   * `rawCachedEventsForAccount`'s query (already extended above to select
   * `meeting_url`) rejects with a real Postgres error (`column
   * "meeting_url" does not exist`).
   */
  it('6. an event with a meetingUrl results in that meetingUrl being persisted into calendar_events_cache.meeting_url', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      {
        externalId: 'ext-with-meeting-url',
        title: 'Sprint planning',
        start: eventStart,
        end: eventEnd,
        meetingUrl: 'https://meet.google.com/xyz-abcd-efg',
      },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    const rows = await rawCachedEventsForAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meeting_url).toBe('https://meet.google.com/xyz-abcd-efg');
  });

  it('7. an event WITHOUT a meetingUrl results in a null meeting_url column (not an error, not a missing row)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      {
        externalId: 'ext-without-meeting-url',
        title: 'A meeting with no video-call link',
        start: eventStart,
        end: eventEnd,
      },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    const rows = await rawCachedEventsForAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meeting_url).toBeNull();
  });

  it('8. re-polling the same externalId with an updated meetingUrl updates it via onConflictDoUpdate (not a stale/duplicate row)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      {
        externalId: 'ext-meeting-url-update',
        title: 'Rescheduled meeting',
        start: eventStart,
        end: eventEnd,
        meetingUrl: 'https://zoom.us/j/111111111',
      },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    connector.events = [
      {
        externalId: 'ext-meeting-url-update',
        title: 'Rescheduled meeting',
        start: eventStart,
        end: eventEnd,
        meetingUrl: 'https://zoom.us/j/222222222',
      },
    ];
    await poller.pollOnce();

    const rows = await rawCachedEventsForAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meeting_url).toBe('https://zoom.us/j/222222222');
  });
});
