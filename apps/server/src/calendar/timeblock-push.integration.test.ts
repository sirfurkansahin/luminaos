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
  TimeBlockDraft,
} from '@luminaos/integrations';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR5d (RED step, part 2 of 2) — the external-calendar push SIDE
 * EFFECT that fires when a `timeblock`'s schedule changes via the two HTTP
 * routes pinned by the sibling file `../objects/timeblock-http.integration.test.ts`.
 *
 * ============================================================================
 * ARCHITECTURAL DECISION THIS FILE PINS (already made, not relitigated here):
 * the push is a PLAIN INJECTABLE SERVICE call (`TimeBlockPushService`)
 * triggered directly and EXACTLY ONCE by `ObjectsService.scheduleTimeBlock`/
 * `.clearTimeBlockSchedule`, immediately after their own
 * `applyCommandWithFieldValues` call resolves — NOT a `Projection`. Per
 * `packages/shared/src/events/projection.ts`'s contract, projections must be
 * safely re-runnable/rebuildable from scratch; replaying `TimeBlockScheduled`
 * history through a projection-rebuild would redundantly re-push to the
 * external API on every rebuild, which is wrong for a side effect that must
 * fire once per actual state change. Mirrors how `AIRefreshScheduler`'s
 * side-effect trigger is invoked inline by the command-handling code, never
 * via the projection-replay path.
 *
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `db/schema/timeblock-external-pushes.ts` (new) — `timeblockExternalPushes`
 *    table: `id` (uuid pk), `objectId` (varchar(26), the timeblock's ULID, NO
 *    FK to `objects_view` — mirrors F1-T11 PR2's `document_snapshots`
 *    precedent), `calendarAccountId` (uuid, FK -> `calendarAccounts.id`,
 *    cascade), `externalId` (text), `createdAt`/`updatedAt` (timestamptz),
 *    unique index on `(objectId, calendarAccountId)`. Plus an up+down
 *    migration.
 *
 * B. `calendar/timeblock-push.service.ts` (new) — `@Injectable()
 *    TimeBlockPushService`, injecting `DATABASE_CONNECTION` and
 *    `@Inject(CALENDAR_CONNECTOR) connector`.
 *      - `pushScheduled(objectId, workspaceId, createdBy, title, schedule)`:
 *        for EVERY `calendar_accounts` row belonging to `(workspaceId,
 *        createdBy)` (the timeblock CREATOR's own accounts — never the
 *        caller's, if different), independently try/catch: no existing
 *        `timeblock_external_pushes` mapping -> `connector.createEvent(...)`
 *        + insert a mapping row; an existing mapping -> `connector.updateEvent
 *        (existing.externalId, ...)` + touch `updatedAt`. Zero connected
 *        accounts is a SILENT no-op, not an error.
 *      - `pushCleared(objectId)`: for every mapping row for `objectId`,
 *        independently try/catch: `connector.deleteEvent(externalId)` then
 *        delete the mapping row; on failure, leave the mapping row in place.
 *
 * C. `calendar/calendar.module.ts` (modify) — adds `TimeBlockPushService` to
 *    both `providers` AND `exports`.
 *
 * D. `objects/objects.service.ts` (modify) — `scheduleTimeBlock`/
 *    `clearTimeBlockSchedule` call `this.timeBlockPush.pushScheduled(...)`/
 *    `.pushCleared(...)` AFTER their own `applyCommandWithFieldValues` call
 *    resolves, wrapped in try/catch so a push failure NEVER fails the HTTP
 *    request — the command already succeeded and was durably persisted by
 *    the time the push is attempted.
 *
 * E. `objects/objects.module.ts` (modify) — imports `CalendarModule` (so
 *    `ObjectsService` can inject the newly-exported `TimeBlockPushService`).
 *
 * ----------------------------------------------------------------------------
 * INVARIANT THIS FILE IS SPECIFICALLY DESIGNED TO CATCH A REGRESSION OF: the
 * push is best-effort and MUST NEVER fail the HTTP request, even when the
 * connector itself throws (test 5) — the domain command's own success is
 * never contingent on the external push succeeding.
 *
 * HARNESS NOTE: same Testcontainers Postgres 16 + Redis 7 pair,
 * `ENCRYPTION_KEY` env-setup timing, and register/create-workspace/connect-
 * account HTTP helpers as `calendar-token-refresh.integration.test.ts` /
 * `calendar-sync-poller.integration.test.ts`, duplicated here per this
 * codebase's established self-contained-integration-test convention. A
 * SINGLE app boot serves the whole file, with `CALENDAR_CONNECTOR` overridden
 * by `MutableCalendarConnector` below (a small stub, NOT `MockCalendarConnector`,
 * because this file needs to reconfigure `createEvent`'s failure behavior
 * mid-suite and reset call-recording arrays between `it`s — mirrors
 * `calendar-sync-poller.integration.test.ts`'s own `ScriptedCalendarConnector`
 * mutable-state technique). This file deliberately does NOT need a dynamic
 * import of `TimeBlockPushService` itself — every case drives the push purely
 * through the real HTTP routes (`POST`/`DELETE .../timeblock`) and observes
 * it indirectly via the connector's own call-recording arrays plus raw SQL
 * against `timeblock_external_pushes`, so no direct reference to the
 * not-yet-existing service class is needed anywhere in this file.
 *
 * `timeblock_external_pushes` is queried via the raw `pg` driver
 * (`rawDb.$client.query`), never via a typed Drizzle schema import — same
 * rationale as `timeblock-projection.integration.test.ts`'s own raw-row
 * helper: a typed reference to a schema object that doesn't exist yet would
 * fail `pnpm typecheck` forever, defeating the point of a RED step that turns
 * cleanly GREEN with zero further edits to this test file.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `POST`/`DELETE .../objects/:objectId/timeblock`
 * don't exist on `ObjectsController` at all (see the sibling HTTP test file),
 * so every request below hits Nest's default 404 handler before the push
 * side effect this file is actually about ever has a chance to run — the
 * correct red: the routes AND the service this PR adds simply don't exist
 * yet, not a test-logic bug. Once the routes/service exist but before the
 * `timeblock_external_pushes` migration exists, the failure mode shifts to
 * this file's own raw verification queries rejecting with a real Postgres
 * error (`relation "timeblock_external_pushes" does not exist`).
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface CalendarAccountBody {
  id: string;
  provider: string;
  expiresAt: string;
}

interface CalendarAccountEnvelope {
  account: CalendarAccountBody;
}

interface ObjectBody {
  id: string;
  title: string;
  timeBlock?: { start: string; end: string };
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface RawPushRow {
  id: string;
  object_id: string;
  calendar_account_id: string;
  external_id: string;
  created_at: Date;
  updated_at: Date;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `timeblock-push-test-user-${String(emailCounter)}@example.com`;
}

/**
 * A mutable-state `CalendarConnector` test double, distinct from
 * `MockCalendarConnector` (whose behavior is fixed at construction) so this
 * file can flip `createEvent` into a scripted-failure mode mid-suite (test 5)
 * and reset all call-recording arrays between `it`s (`reset()`, called from
 * `beforeEach`) without re-booting Nest per test — mirrors
 * `calendar-sync-poller.integration.test.ts`'s `ScriptedCalendarConnector`.
 * `listEvents`/`refreshToken` are not exercised by the push side effect and
 * are deliberately trivial stubs.
 */
class MutableCalendarConnector implements CalendarConnector {
  createdEvents: { externalId: string; draft: TimeBlockDraft }[] = [];
  updatedEvents: { externalId: string; draft: TimeBlockDraft }[] = [];
  deletedEventIds: string[] = [];
  createEventShouldFail = false;

  private counter = 0;

  reset(): void {
    this.createdEvents = [];
    this.updatedEvents = [];
    this.deletedEventIds = [];
    this.createEventShouldFail = false;
  }

  listEvents(): Promise<ExternalCalendarEvent[]> {
    return Promise.resolve([]);
  }

  createEvent(draft: TimeBlockDraft): Promise<{ externalId: string }> {
    if (this.createEventShouldFail) {
      return Promise.reject(new Error('scripted createEvent failure'));
    }

    this.counter += 1;
    const externalId = `mutable-event-${String(this.counter)}`;
    this.createdEvents.push({ externalId, draft });
    return Promise.resolve({ externalId });
  }

  updateEvent(externalId: string, draft: TimeBlockDraft): Promise<void> {
    this.updatedEvents.push({ externalId, draft });
    return Promise.resolve();
  }

  deleteEvent(externalId: string): Promise<void> {
    this.deletedEventIds.push(externalId);
    return Promise.resolve();
  }

  refreshToken(account: CalendarAccount): Promise<RefreshedTokens> {
    return Promise.resolve({
      accessToken: 'mutable-refreshed-access-token',
      expiresAt: new Date(new Date(account.expiresAt).getTime() + 3_600_000).toISOString(),
    });
  }
}

describe('F1-T12 PR5d (RED step, part 2/2): TimeBlockPushService — one-way push of timeblock schedules to the connected external calendar (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let connector: MutableCalendarConnector;

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

    connector = new MutableCalendarConnector();

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
    connector.reset();
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
      .send({ name: `Timeblock push test workspace ${String(emailCounter)}` });
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

  async function createTimeblock(
    cookie: string,
    workspaceId: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'timeblock', title });
    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  async function scheduleTimeblock(
    cookie: string,
    workspaceId: string,
    objectId: string,
    start: string,
    end: string,
  ): Promise<request.Response> {
    return request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/timeblock`)
      .set('Cookie', cookie)
      .send({ start, end });
  }

  async function clearTimeblock(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`/workspaces/${workspaceId}/objects/${objectId}/timeblock`)
      .set('Cookie', cookie);
  }

  async function rawPushRows(objectId: string): Promise<RawPushRow[]> {
    const result = await rawDb.$client.query<RawPushRow>(
      'select id, object_id, calendar_account_id, external_id, created_at, updated_at from timeblock_external_pushes where object_id = $1 order by created_at',
      [objectId],
    );
    return result.rows;
  }

  it('1. first schedule on a timeblock whose creator HAS a connected calendar account -> createEvent + a mapping row is inserted', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);
    const object = await createTimeblock(cookie, workspaceId, 'Focus block');

    const start = '2026-05-01T09:00:00.000Z';
    const end = '2026-05-01T10:00:00.000Z';

    const response = await scheduleTimeblock(cookie, workspaceId, object.id, start, end);
    expect(response.status).toBe(200);

    expect(connector.createdEvents).toHaveLength(1);
    const createCall = connector.createdEvents[0];
    expect(createCall?.draft.title).toBe('Focus block');
    expect(new Date(createCall?.draft.start ?? '').getTime()).toBe(new Date(start).getTime());
    expect(new Date(createCall?.draft.end ?? '').getTime()).toBe(new Date(end).getTime());

    const rows = await rawPushRows(object.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.calendar_account_id).toBe(account.id);
    expect(rows[0]?.external_id).toBe(createCall?.externalId);
  });

  it('2. re-scheduling the SAME timeblock with different start/end -> updateEvent on the SAME externalId, not a second createEvent', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);
    const object = await createTimeblock(cookie, workspaceId, 'Reschedule block');

    const firstResponse = await scheduleTimeblock(
      cookie,
      workspaceId,
      object.id,
      '2026-05-02T09:00:00.000Z',
      '2026-05-02T10:00:00.000Z',
    );
    expect(firstResponse.status).toBe(200);
    expect(connector.createdEvents).toHaveLength(1);
    const externalId = connector.createdEvents[0]?.externalId;

    const newStart = '2026-05-02T14:00:00.000Z';
    const newEnd = '2026-05-02T15:30:00.000Z';
    const secondResponse = await scheduleTimeblock(
      cookie,
      workspaceId,
      object.id,
      newStart,
      newEnd,
    );
    expect(secondResponse.status).toBe(200);

    // Idempotent create-then-update: exactly one createEvent ever, and the
    // update targets the SAME externalId the first createEvent returned.
    expect(connector.createdEvents).toHaveLength(1);
    expect(connector.updatedEvents).toHaveLength(1);
    const updateCall = connector.updatedEvents[0];
    expect(updateCall?.externalId).toBe(externalId);
    expect(new Date(updateCall?.draft.start ?? '').getTime()).toBe(new Date(newStart).getTime());
    expect(new Date(updateCall?.draft.end ?? '').getTime()).toBe(new Date(newEnd).getTime());

    const rows = await rawPushRows(object.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_id).toBe(externalId);
  });

  it('3. clearing a scheduled timeblock -> deleteEvent, and the mapping row is removed', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);
    const object = await createTimeblock(cookie, workspaceId, 'To be cleared');

    await scheduleTimeblock(
      cookie,
      workspaceId,
      object.id,
      '2026-05-03T09:00:00.000Z',
      '2026-05-03T10:00:00.000Z',
    );
    const externalId = connector.createdEvents[0]?.externalId;
    expect(externalId).toBeDefined();

    const response = await clearTimeblock(cookie, workspaceId, object.id);
    expect(response.status).toBe(200);
    expect((response.body as ObjectEnvelope).object.timeBlock).toBeUndefined();

    expect(connector.deletedEventIds).toContain(externalId);

    const rows = await rawPushRows(object.id);
    expect(rows).toHaveLength(0);
  });

  it('4. the timeblock creator has ZERO connected calendar accounts -> scheduling succeeds, no push happens (silent no-op)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    // Deliberately never calling connectAccount() here.
    const object = await createTimeblock(cookie, workspaceId, 'No calendar connected');

    const response = await scheduleTimeblock(
      cookie,
      workspaceId,
      object.id,
      '2026-05-04T09:00:00.000Z',
      '2026-05-04T10:00:00.000Z',
    );

    expect(response.status).toBe(200);
    const updated = (response.body as ObjectEnvelope).object;
    expect(updated.timeBlock).toBeDefined();

    expect(connector.createdEvents).toHaveLength(0);

    const rows = await rawPushRows(object.id);
    expect(rows).toHaveLength(0);
  });

  it('5. the external push fails (createEvent rejects) -> the HTTP request STILL succeeds with the persisted schedule (push is best-effort, never fails the request)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await connectAccount(cookie, workspaceId);
    const object = await createTimeblock(cookie, workspaceId, 'Push will fail');

    connector.createEventShouldFail = true;

    const start = '2026-05-05T09:00:00.000Z';
    const end = '2026-05-05T10:00:00.000Z';
    const response = await scheduleTimeblock(cookie, workspaceId, object.id, start, end);

    expect(response.status).toBe(200);
    const updated = (response.body as ObjectEnvelope).object;
    expect(new Date(updated.timeBlock?.start ?? '').getTime()).toBe(new Date(start).getTime());
    expect(new Date(updated.timeBlock?.end ?? '').getTime()).toBe(new Date(end).getTime());

    // The scripted failure means no successful create was ever recorded, and
    // therefore no mapping row was ever inserted either.
    expect(connector.createdEvents).toHaveLength(0);
    const rows = await rawPushRows(object.id);
    expect(rows).toHaveLength(0);
  });
});
