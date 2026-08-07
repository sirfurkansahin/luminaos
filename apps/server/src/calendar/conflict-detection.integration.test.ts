import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR7 (RED step) — read-time, warning-only conflict detection between
 * a user's `timeblock` objects and cached external calendar events
 * (ADR-0012 §g, Kabul Kriteri #4).
 *
 * SPEC WORDING PINNED (docs/specs/F1-E3/F1-T12-takvim.md, Kapsam item 4):
 *   "Çakışma tespiti: Aynı kullanıcı için aynı zaman aralığında örtüşen iki
 *   `timeblock` (veya bir `timeblock` ve içeri çekilen dış etkinlik), F1-T8
 *   Calendar görünümünde uyarı rozeti ile işaretlenir (engelleme değil,
 *   yalnızca uyarı)." — conflicts are scoped to overlaps WITHIN the SAME
 *   user's own timeblocks/external events, never across two different
 *   workspace members. This file's test 4 pins that scoping directly.
 *
 * ADR-0012 §g reminders this file also pins as behavior, not just prose:
 *   - Conflict detection is DERIVED and READ-TIME ONLY — never event-sourced,
 *     never a persisted column, never computed on write.
 *   - It is WARNING-ONLY: creating/scheduling an overlapping `timeblock` must
 *     NEVER be rejected (test 7 is the regression proof for this).
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `calendar/dto/list-conflicts.schema.ts` (new) — zod
 *    `z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).strict()`,
 *    exporting a `ListConflictsQuery` type. Mirrors
 *    `dto/list-calendar-events.schema.ts`'s style exactly.
 *
 * B. `calendar/conflict-detection.service.ts` (new) — exports
 *    `ConflictInterval` (`{kind: 'timeblock'|'external'; id: string; title:
 *    string; start: string; end: string}`) and `ConflictPair` (`{a:
 *    ConflictInterval; b: ConflictInterval}`). `@Injectable()
 *    ConflictDetectionService.findConflicts(workspaceId: string, userId:
 *    string, range: {start: string; end: string}): Promise<ConflictPair[]>`:
 *      1. Selects `userId`'s own scheduled `timeblock` objects in
 *         `workspaceId` overlapping `range` from `objectsView`
 *         (`type = 'timeblock' AND createdBy = userId AND lifecycle !=
 *         'deleted' AND timeBlockStart IS NOT NULL AND timeBlockStart <
 *         range.end AND timeBlockEnd > range.start`).
 *      2. Selects `userId`'s cached external events in `workspaceId`
 *         overlapping `range`, joining `calendarEventsCache` to
 *         `calendarAccounts` on `calendarAccountId = calendarAccounts.id`,
 *         filtered by `calendarAccounts.userId = userId`.
 *      3. Finds ALL pairwise overlaps across the combined interval list
 *         (any kind combination), returning one `ConflictPair` per
 *         overlapping pair. Empty array when there are none.
 *      4. Purely read-only — no writes, no blocking.
 *
 * C. `calendar/conflicts.controller.ts` (new) — `@Controller(
 *    'workspaces/:workspaceId/calendar/conflicts')`, `@Get()`,
 *    `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)`,
 *    `@Param('workspaceId', ParseUUIDPipe)`, `@Query(new
 *    ZodValidationPipe(listConflictsSchema)) query`, fail-closed
 *    `req.user`/`req.membership` checks, calls
 *    `service.findConflicts(workspaceId, req.user.id, query)`. 200, body
 *    `{ conflicts: ConflictPair[] }`.
 *
 * D. `calendar/calendar.module.ts` (modify) — adds `ConflictDetectionService`
 *    to `providers` and `ConflictsController` to `controllers`.
 *
 * ----------------------------------------------------------------------------
 * SEEDING STRATEGY: `timeblock` objects are seeded via the real HTTP routes
 * pinned by `../objects/timeblock-http.integration.test.ts` (PR5d):
 * `POST /workspaces/:workspaceId/objects {objectType:'timeblock', title}`
 * then `POST :objectId/timeblock {start,end}`. A calendar account is
 * connected via the real `POST .../calendar/accounts` route (PR5a). The
 * cached external event itself is seeded via a DIRECT raw SQL insert into
 * `calendar_events_cache`, referencing that real `calendar_accounts.id` —
 * deliberately bypassing the poller, since polling itself is PR5c's own
 * already-tested concern, not this PR's, mirroring
 * `calendar-events.integration.test.ts` test 3's identical rationale.
 * A second workspace member is seeded via a direct `memberships` table
 * insert (`addMemberWithRole`), mirroring
 * `../objects/object-query.integration.test.ts`'s identical helper — no HTTP
 * "invite member" route exists in this codebase.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `ConflictsController` does not exist and
 * `CalendarModule` does not provide it, so EVERY
 * `GET /workspaces/:workspaceId/calendar/conflicts` request in this file
 * 404s via Nest's own default "Cannot GET ..." handler (not `AppErrorFilter`)
 * — including tests 8/9, which expect 401/403/400 but will actually see 404
 * today, same "coincidental 404" precedent as this feature's other RED test
 * files (`calendar-accounts.integration.test.ts`,
 * `object-query.integration.test.ts`). Test 7's regression-proof assertion
 * (`POST .../timeblock` returning 200) is UNAFFECTED by this route's absence
 * and should already pass today if PR5d/PR2/PR3 are merged — it is included
 * here purely as a documented non-blocking guarantee, not a new red
 * assertion caused by this PR.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectBody {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  timeBlock?: { start: string; end: string };
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

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

interface ConflictInterval {
  kind: 'timeblock' | 'external';
  id: string;
  title: string;
  start: string;
  end: string;
}

interface ConflictPair {
  a: ConflictInterval;
  b: ConflictInterval;
}

interface ConflictsEnvelope {
  conflicts: ConflictPair[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `conflict-detection-test-user-${String(emailCounter)}@example.com`;
}

describe('F1-T12 PR7 (RED step): GET .../calendar/conflicts — read-time, warning-only timeblock/external-event conflict detection (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Conflict detection test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  /** Adds a SECOND user as a member of an existing workspace via a direct
   * `memberships` table insert — mirrors
   * `../objects/object-query.integration.test.ts`'s identical helper; no
   * HTTP "invite member" route exists in this codebase. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  function objectsUrl(workspaceId: string, objectId?: string): string {
    return objectId
      ? `/workspaces/${workspaceId}/objects/${objectId}`
      : `/workspaces/${workspaceId}/objects`;
  }

  async function createTimeblock(
    cookie: string,
    workspaceId: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(objectsUrl(workspaceId))
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
      .post(`${objectsUrl(workspaceId, objectId)}/timeblock`)
      .set('Cookie', cookie)
      .send({ start, end });
  }

  async function createScheduledTimeblock(
    cookie: string,
    workspaceId: string,
    title: string,
    start: string,
    end: string,
  ): Promise<ObjectBody> {
    const object = await createTimeblock(cookie, workspaceId, title);
    const response = await scheduleTimeblock(cookie, workspaceId, object.id, start, end);
    expect(response.status).toBe(200);
    return (response.body as ObjectEnvelope).object;
  }

  async function connectAccount(cookie: string, workspaceId: string): Promise<CalendarAccountBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/calendar/accounts`)
      .set('Cookie', cookie)
      .send({ provider: 'google' });

    expect(response.status).toBe(201);
    return (response.body as CalendarAccountEnvelope).account;
  }

  /** Directly inserts a `calendar_events_cache` row, bypassing the poller
   * entirely — mirrors `calendar-events.integration.test.ts`'s identical
   * `insertRawCachedEvent` helper and rationale. */
  async function insertRawCachedEvent(params: {
    calendarAccountId: string;
    workspaceId: string;
    externalId: string;
    title: string;
    eventStart: string;
    eventEnd: string;
  }): Promise<void> {
    await rawDb.$client.query(
      `insert into calendar_events_cache
         (calendar_account_id, workspace_id, external_id, title, event_start, event_end)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        params.calendarAccountId,
        params.workspaceId,
        params.externalId,
        params.title,
        params.eventStart,
        params.eventEnd,
      ],
    );
  }

  function conflictsUrl(workspaceId: string, start?: string, end?: string): string {
    const query = new URLSearchParams();
    if (start !== undefined) query.set('start', start);
    if (end !== undefined) query.set('end', end);
    const qs = query.toString();
    return `/workspaces/${workspaceId}/calendar/conflicts${qs.length > 0 ? `?${qs}` : ''}`;
  }

  function pairIds(pair: ConflictPair): [string, string] {
    return [pair.a.id, pair.b.id].sort() as [string, string];
  }

  it('1. no conflicts: two non-overlapping timeblocks -> 200 { conflicts: [] }', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Morning block',
      '2026-05-01T09:00:00.000Z',
      '2026-05-01T10:00:00.000Z',
    );
    await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Afternoon block',
      '2026-05-01T14:00:00.000Z',
      '2026-05-01T15:00:00.000Z',
    );

    const response = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect((response.body as ConflictsEnvelope).conflicts).toEqual([]);
  });

  it('2. two overlapping timeblocks for the SAME user -> exactly one ConflictPair, both kind "timeblock"', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const first = await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Block A',
      '2026-05-02T09:00:00.000Z',
      '2026-05-02T10:00:00.000Z',
    );
    const second = await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Block B',
      '2026-05-02T09:30:00.000Z',
      '2026-05-02T10:30:00.000Z',
    );

    const response = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-02T00:00:00.000Z', '2026-05-03T00:00:00.000Z'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { conflicts } = response.body as ConflictsEnvelope;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.a.kind).toBe('timeblock');
    expect(conflicts[0]?.b.kind).toBe('timeblock');
    expect(conflicts[0] ? pairIds(conflicts[0]) : []).toEqual([first.id, second.id].sort());
  });

  it('3. a timeblock overlapping a cached external event on the SAME user\'s connected account -> one ConflictPair, kind "timeblock" + kind "external"', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const account = await connectAccount(cookie, workspaceId);

    const timeblock = await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Focus block',
      '2026-05-03T09:00:00.000Z',
      '2026-05-03T10:00:00.000Z',
    );

    await insertRawCachedEvent({
      calendarAccountId: account.id,
      workspaceId,
      externalId: 'ext-conflict-1',
      title: 'External meeting',
      eventStart: '2026-05-03T09:30:00.000Z',
      eventEnd: '2026-05-03T10:30:00.000Z',
    });

    const response = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-03T00:00:00.000Z', '2026-05-04T00:00:00.000Z'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { conflicts } = response.body as ConflictsEnvelope;
    expect(conflicts).toHaveLength(1);
    const kinds = conflicts[0] ? [conflicts[0].a.kind, conflicts[0].b.kind].sort() : [];
    expect(kinds).toEqual(['external', 'timeblock']);
    const ids = conflicts[0] ? [conflicts[0].a.id, conflicts[0].b.id] : [];
    expect(ids).toContain(timeblock.id);
    expect(ids).toContain('ext-conflict-1');
  });

  it('4. different USERS\' overlapping timeblocks are NEVER reported (spec-pinned "aynı kullanıcı için" scoping)', async () => {
    const owner = await registerOwnerWithWorkspace();
    const other = await addMemberWithRole(owner.workspaceId, 'member');

    const ownerBlock = await createScheduledTimeblock(
      owner.cookie,
      owner.workspaceId,
      "Owner's block",
      '2026-05-04T09:00:00.000Z',
      '2026-05-04T10:00:00.000Z',
    );
    await createScheduledTimeblock(
      other.cookie,
      owner.workspaceId,
      "Other member's overlapping block",
      '2026-05-04T09:30:00.000Z',
      '2026-05-04T10:30:00.000Z',
    );

    const response = await request(server)
      .get(conflictsUrl(owner.workspaceId, '2026-05-04T00:00:00.000Z', '2026-05-05T00:00:00.000Z'))
      .set('Cookie', owner.cookie);

    expect(response.status).toBe(200);
    const { conflicts } = response.body as ConflictsEnvelope;
    // The owner has only ONE scheduled timeblock in range -- with no other
    // interval of THEIRS to overlap, there must be no conflicts at all, and
    // in particular never one involving the other member's block.
    expect(conflicts).toEqual([]);
    for (const pair of conflicts) {
      expect([pair.a.id, pair.b.id]).not.toContain(ownerBlock.id);
    }
  });

  it('5. range filtering: a conflict entirely outside the requested range is excluded', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Far block A',
      '2026-06-01T09:00:00.000Z',
      '2026-06-01T10:00:00.000Z',
    );
    await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Far block B',
      '2026-06-01T09:30:00.000Z',
      '2026-06-01T10:30:00.000Z',
    );

    const response = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect((response.body as ConflictsEnvelope).conflicts).toEqual([]);
  });

  it('6. empty result is a normal 200, never 404/error', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(404);
    const { conflicts } = response.body as ConflictsEnvelope;
    expect(conflicts).toEqual([]);
  });

  it('7. non-blocking regression proof: scheduling a SECOND overlapping timeblock still returns 200 (conflict detection never rejects a write)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await createScheduledTimeblock(
      cookie,
      workspaceId,
      'Existing block',
      '2026-05-06T09:00:00.000Z',
      '2026-05-06T10:00:00.000Z',
    );

    const secondObject = await createTimeblock(cookie, workspaceId, 'Overlapping block');
    const response = await scheduleTimeblock(
      cookie,
      workspaceId,
      secondObject.id,
      '2026-05-06T09:30:00.000Z',
      '2026-05-06T10:30:00.000Z',
    );

    expect(response.status).toBe(200);
  });

  it('8. unauthenticated -> 401; authenticated but not a workspace member -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const start = '2026-05-01T00:00:00.000Z';
    const end = '2026-05-02T00:00:00.000Z';

    const unauthenticatedResponse = await request(server).get(
      conflictsUrl(workspaceId, start, end),
    );
    expect(unauthenticatedResponse.status).toBe(401);

    const { cookie: outsiderCookie } = await registerUser();
    const nonMemberResponse = await request(server)
      .get(conflictsUrl(workspaceId, start, end))
      .set('Cookie', outsiderCookie);
    expect(nonMemberResponse.status).toBe(403);
  });

  it('9. missing "start"/"end" query params -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const missingBoth = await request(server).get(conflictsUrl(workspaceId)).set('Cookie', cookie);
    expect(missingBoth.status).toBe(400);

    const missingEnd = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-01T00:00:00.000Z'))
      .set('Cookie', cookie);
    expect(missingEnd.status).toBe(400);
  });

  it('10. end <= start, or a range spanning more than 366 days, -> 400 (security review: unbounded-range DoS guard)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const endBeforeStart = await request(server)
      .get(conflictsUrl(workspaceId, '2026-05-02T00:00:00.000Z', '2026-05-01T00:00:00.000Z'))
      .set('Cookie', cookie);
    expect(endBeforeStart.status).toBe(400);

    const tooWideRange = await request(server)
      .get(conflictsUrl(workspaceId, '2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'))
      .set('Cookie', cookie);
    expect(tooWideRange.status).toBe(400);

    const withinCap = await request(server)
      .get(conflictsUrl(workspaceId, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'))
      .set('Cookie', cookie);
    expect(withinCap.status).toBe(200);
  });
});
