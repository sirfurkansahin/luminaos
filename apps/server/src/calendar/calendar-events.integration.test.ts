import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  CalendarAccount,
  CalendarConnector,
  ExternalCalendarEvent,
  RefreshedTokens,
} from '@luminaos/integrations';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR5c (RED step, part 2 of 2) -- the read-only GET route half of
 * "salt-okunur görünür" (Kabul Kriteri #1): reading previously-polled
 * external calendar events back out of `calendar_events_cache`. The
 * schema/poller half of the contract is pinned by the sibling file
 * `calendar-sync-poller.integration.test.ts` -- read that file's header
 * comment for the FULL `calendar_events_cache` table shape and
 * `CalendarSyncPollerService.pollOnce()` contract; this file's header only
 * restates the GET-route-specific pieces.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `calendar/dto/list-calendar-events.schema.ts` (new) -- zod
 *    `{ start: z.string(), end: z.string() }.strict()`, both REQUIRED
 *    ISO-8601 datetime strings (see `../../objects/dto/list-objects.schema.ts`
 *    for this codebase's query-schema `.strict()` convention).
 *
 * B. `calendar/calendar-events.service.ts` (new) -- `@Injectable()
 *    CalendarEventsService.listCachedEvents(workspaceId: string, range:
 *    {start: string; end: string}): Promise<Array<{externalId: string;
 *    title: string; start: string; end: string}>>` -- selects from
 *    `calendarEventsCache` scoped to `workspaceId` AND overlapping the given
 *    range (`eventStart < range.end && eventEnd > range.start`, mirroring
 *    `MockCalendarConnector.listEvents`'s own overlap predicate), mapping
 *    `eventStart`/`eventEnd` back to ISO-string `start`/`end`. NEVER selects
 *    or joins any `calendar_accounts` token column (same no-token-leakage
 *    discipline as `calendar-accounts.service.ts`).
 *
 * C. `calendar/calendar-events.controller.ts` (new) -- `@Controller(
 *    'workspaces/:workspaceId/calendar/events')`, `@Get()`, `@UseGuards(
 *    SessionAuthGuard, WorkspaceMembershipGuard)`, `@Param('workspaceId',
 *    ParseUUIDPipe)`, `@Query(new ZodValidationPipe(listCalendarEventsQuerySchema))`
 *    for `start`/`end`. 200, body `{ events: [...] }`.
 *
 * D. `calendar/calendar.module.ts` (modify) -- adds `CalendarEventsService` to
 *    providers and `CalendarEventsController` to controllers (alongside PR5c's
 *    `CalendarSyncPollerService`, pinned by the sibling file).
 *
 * ----------------------------------------------------------------------------
 * SEEDING STRATEGY: test 1/2 seed the cache the REAL way -- connecting an
 * account via HTTP then calling `CalendarSyncPollerService.pollOnce()`
 * directly (same `ScriptedCalendarConnector` stand-in as the sibling poller
 * test file). Test 3 (cross-tenant isolation) instead seeds workspace B's
 * cache row via a DIRECT raw SQL insert into `calendar_events_cache` --
 * deliberately bypassing the poller -- so that assertion is a pure test of
 * the GET route's own `workspaceId` scoping, uncomplicated by this PR's
 * documented architectural simplification (the poller's single global
 * connector instance returning the SAME events for every account processed
 * within one `pollOnce()` cycle, see the sibling file's header comment) --
 * calling `pollOnce()` a second time after connecting workspace B's account
 * would ALSO re-poll (and mutate) workspace A's already-cached row, which
 * would make this test's assertions depend on that unrelated behavior
 * instead of purely on the GET route's tenant scoping.
 *
 * HARNESS NOTE: same Testcontainers Postgres 16 + Redis 7 pair,
 * `ENCRYPTION_KEY` env-setup timing, and register/create-workspace/connect-
 * account HTTP helpers as this feature's other integration test files,
 * duplicated here per this codebase's established self-contained-
 * integration-test convention.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `CalendarEventsController` nor
 * `CalendarSyncPollerService` exist and `CalendarModule` does not provide
 * them, so EVERY `GET /workspaces/:workspaceId/calendar/events` request in
 * this file 404s as an unmatched route (including tests 4/5, which expect
 * 400/401/403 but will actually see 404 today) -- mirrors
 * `calendar-accounts.integration.test.ts`'s (PR5a) identical "every route
 * 404s" red-state note. Additionally, the dynamic
 * `import('./calendar-sync-poller.service.js')` inside `beforeAll` REJECTS
 * ("Cannot find module"), which alone fails `beforeAll` and thus every `it`
 * in this file today -- the correct red, not a test-logic bug. The raw-insert
 * seeding in test 3 fails differently once `beforeAll` itself is fixed up to
 * that point: `rawDb.$client.query(...)` REJECTS with a real Postgres error
 * (`relation "calendar_events_cache" does not exist`), since the migration
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

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface CalendarEventBody {
  externalId: string;
  title: string;
  start: string;
  end: string;
  meetingUrl?: string;
}

interface CalendarEventsEnvelope {
  events: CalendarEventBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `calendar-events-test-user-${String(emailCounter)}@example.com`;
}

function defaultRefreshTokenResponder(): Promise<RefreshedTokens> {
  return Promise.resolve({
    accessToken: 'scripted-refreshed-access-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/** See the sibling `calendar-sync-poller.integration.test.ts`'s identical
 * class for the full rationale -- duplicated here per this codebase's
 * established self-contained-integration-test convention. */
class ScriptedCalendarConnector implements CalendarConnector {
  events: ExternalCalendarEvent[] = [];
  refreshTokenResponder: (account: CalendarAccount) => Promise<RefreshedTokens> =
    defaultRefreshTokenResponder;

  listEvents(): Promise<ExternalCalendarEvent[]> {
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

/**
 * `calendar-sync-poller.service.ts` doesn't exist yet -- see the sibling
 * poller test file's identical `*Like`/`*Constructor` escape-hatch comment
 * for the full rationale. This file only needs `pollOnce()` to seed the
 * cache via HTTP + a real poll cycle for tests 1/2.
 */
interface CalendarSyncPollerServiceLike {
  pollOnce(): Promise<void>;
}

interface CalendarSyncPollerServiceConstructor {
  new (...args: unknown[]): CalendarSyncPollerServiceLike;
}

describe('F1-T12 PR5c (RED step): GET .../calendar/events -- reading the read-only external-calendar cache (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
      .send({ name: `Calendar events test workspace ${String(emailCounter)}` });
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

  function eventsUrl(workspaceId: string, start: string, end: string): string {
    return `/workspaces/${workspaceId}/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  }

  /** Directly inserts a `calendar_events_cache` row, bypassing the poller
   * entirely -- see this file's header comment ("SEEDING STRATEGY") for why
   * test 3 needs this instead of a second `pollOnce()` call. */
  async function insertRawCachedEvent(params: {
    calendarAccountId: string;
    workspaceId: string;
    externalId: string;
    title: string;
    eventStart: string;
    eventEnd: string;
    meetingUrl?: string | null;
  }): Promise<void> {
    await rawDb.$client.query(
      `insert into calendar_events_cache
         (calendar_account_id, workspace_id, external_id, title, event_start, event_end, meeting_url)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.calendarAccountId,
        params.workspaceId,
        params.externalId,
        params.title,
        params.eventStart,
        params.eventEnd,
        params.meetingUrl ?? null,
      ],
    );
  }

  it('1. GET .../calendar/events with a range overlapping a poll-cached event -> 200, event present with {externalId, title, start, end}', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      { externalId: 'ext-cached-1', title: 'Design review', start: eventStart, end: eventEnd },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    const queryStart = new Date(Date.now()).toISOString();
    const queryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const response = await request(server)
      .get(eventsUrl(workspaceId, queryStart, queryEnd))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { events } = response.body as CalendarEventsEnvelope;
    const match = events.find((event) => event.externalId === 'ext-cached-1');
    expect(match).toBeDefined();
    expect(match?.title).toBe('Design review');
    expect(match?.start).toBe(eventStart);
    expect(match?.end).toBe(eventEnd);
  });

  it('2. an event OUTSIDE the requested range is excluded from the response', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);

    const farFutureStart = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const farFutureEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000 + 3_600_000).toISOString();
    connector.events = [
      {
        externalId: 'ext-out-of-range',
        title: 'Far future event',
        start: farFutureStart,
        end: farFutureEnd,
      },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    const nearQueryStart = new Date(Date.now()).toISOString();
    const nearQueryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const response = await request(server)
      .get(eventsUrl(workspaceId, nearQueryStart, nearQueryEnd))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { events } = response.body as CalendarEventsEnvelope;
    expect(events.some((event) => event.externalId === 'ext-out-of-range')).toBe(false);
  });

  it('3. events cached under a DIFFERENT workspace are never returned (cross-tenant isolation)', async () => {
    const ownerA = await registerOwnerWithWorkspace();
    const ownerB = await registerOwnerWithWorkspace();
    const accountB = await connectAccount(ownerB.cookie, ownerB.workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();

    await insertRawCachedEvent({
      calendarAccountId: accountB.id,
      workspaceId: ownerB.workspaceId,
      externalId: 'ext-workspace-b-only',
      title: "Workspace B's private event",
      eventStart,
      eventEnd,
    });

    const queryStart = new Date(Date.now()).toISOString();
    const queryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const responseA = await request(server)
      .get(eventsUrl(ownerA.workspaceId, queryStart, queryEnd))
      .set('Cookie', ownerA.cookie);
    expect(responseA.status).toBe(200);
    const { events: eventsA } = responseA.body as CalendarEventsEnvelope;
    expect(eventsA.some((event) => event.externalId === 'ext-workspace-b-only')).toBe(false);

    const responseB = await request(server)
      .get(eventsUrl(ownerB.workspaceId, queryStart, queryEnd))
      .set('Cookie', ownerB.cookie);
    expect(responseB.status).toBe(200);
    const { events: eventsB } = responseB.body as CalendarEventsEnvelope;
    expect(eventsB.some((event) => event.externalId === 'ext-workspace-b-only')).toBe(true);
  });

  it('4. missing "start"/"end" query params -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const missingBoth = await request(server)
      .get(`/workspaces/${workspaceId}/calendar/events`)
      .set('Cookie', cookie);
    expect(missingBoth.status).toBe(400);

    const missingEnd = await request(server)
      .get(
        `/workspaces/${workspaceId}/calendar/events?start=${encodeURIComponent(new Date().toISOString())}`,
      )
      .set('Cookie', cookie);
    expect(missingEnd.status).toBe(400);
  });

  it('5. unauthenticated -> 401; authenticated but not a workspace member -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const queryStart = new Date(Date.now()).toISOString();
    const queryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const unauthenticatedResponse = await request(server).get(
      eventsUrl(workspaceId, queryStart, queryEnd),
    );
    expect(unauthenticatedResponse.status).toBe(401);

    const outsider = await registerOwnerWithWorkspace();
    const nonMemberResponse = await request(server)
      .get(eventsUrl(workspaceId, queryStart, queryEnd))
      .set('Cookie', outsider.cookie);
    expect(nonMemberResponse.status).toBe(403);
  });

  /**
   * F2-T13 PR2 (RED step) additions -- `CachedCalendarEvent.meetingUrl`
   * (optional): `listCachedEvents()` must select the new nullable
   * `meeting_url` column and include it (mapped null -> undefined) in the
   * returned/response shape. See the sibling `calendar-connector.test.ts`
   * and `calendar-sync-poller.integration.test.ts` for the rest of this
   * PR's pinned contract.
   *
   * EXPECTED RED STATE (today): `ExternalCalendarEvent` has no `meetingUrl`
   * field, so test 6's object literal (`{ ..., meetingUrl: '...' }`) fails
   * to typecheck; `calendar_events_cache` has no `meeting_url` column, so
   * test 7's `insertRawCachedEvent` call (already extended above to insert
   * `meeting_url`) rejects with a real Postgres error (`column
   * "meeting_url" of relation "calendar_events_cache" does not exist`).
   */
  it('6. GET .../calendar/events includes meetingUrl for a poll-cached event that has one', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();
    connector.events = [
      {
        externalId: 'ext-with-meeting-url',
        title: 'Design review',
        start: eventStart,
        end: eventEnd,
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    ];

    const poller = app.get(CalendarSyncPollerService);
    await poller.pollOnce();

    const queryStart = new Date(Date.now()).toISOString();
    const queryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const response = await request(server)
      .get(eventsUrl(workspaceId, queryStart, queryEnd))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { events } = response.body as CalendarEventsEnvelope;
    const match = events.find((event) => event.externalId === 'ext-with-meeting-url');
    expect(match).toBeDefined();
    expect(match?.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('7. GET .../calendar/events omits meetingUrl (undefined) for a cached event whose meeting_url column is null', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const eventStart = new Date(Date.now() + 3_600_000).toISOString();
    const eventEnd = new Date(Date.now() + 7_200_000).toISOString();

    await insertRawCachedEvent({
      calendarAccountId: account.id,
      workspaceId,
      externalId: 'ext-without-meeting-url',
      title: 'A meeting with no video-call link',
      eventStart,
      eventEnd,
    });

    const queryStart = new Date(Date.now()).toISOString();
    const queryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const response = await request(server)
      .get(eventsUrl(workspaceId, queryStart, queryEnd))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { events } = response.body as CalendarEventsEnvelope;
    const match = events.find((event) => event.externalId === 'ext-without-meeting-url');
    expect(match).toBeDefined();
    expect(match?.meetingUrl).toBeUndefined();
  });
});
