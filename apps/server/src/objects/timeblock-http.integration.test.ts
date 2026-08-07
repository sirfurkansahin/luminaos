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
 * F1-T12 PR5d (RED step, part 1 of 2) — plan section "PR5d — one-way push of
 * timeblock schedules to the connected external calendar", Kabul Kriteri #2.
 *
 * ============================================================================
 * THE GAP THIS FILE CLOSES (context, not new scope): PR2 (`packages/core-
 * objects`, merged) built the pure commands `scheduleTimeBlock`/
 * `clearTimeBlockSchedule`, producing `TimeBlockScheduled`/`TimeBlockCleared`
 * events. PR3 (`apps/server`, merged) built ONLY the read-side persistence
 * (`objects_view.timeBlockStart`/`timeBlockEnd` columns + the projection fold
 * — see `timeblock-projection.integration.test.ts`, which deliberately
 * appends `TimeBlockScheduled`/`TimeBlockCleared` DIRECTLY via
 * `EventStoreService.append`, bypassing HTTP, because at that point no HTTP
 * route to invoke these commands existed at all). Neither PR added any HTTP
 * route that lets a real caller actually SCHEDULE or CLEAR a timeblock. This
 * file is the RED step for adding those two missing routes, mirroring
 * `setRecurrenceRule`/`clearRecurrenceRule` EXACTLY:
 *
 *   POST   /workspaces/:workspaceId/objects/:objectId/timeblock   body: { start, end }
 *   DELETE /workspaces/:workspaceId/objects/:objectId/timeblock   (no body)
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   - `dto/schedule-timeblock.schema.ts` (new): `{ start: z.iso.datetime(),
 *     end: z.iso.datetime() }.strict()`, mirroring `set-recurrence-rule.schema.ts`'s
 *     style.
 *   - `ObjectsService.scheduleTimeBlock`/`.clearTimeBlockSchedule` (new): both
 *     delegate to the existing private `applyCommandWithFieldValues` helper,
 *     invoking `scheduleTimeBlock`/`clearTimeBlockSchedule` from
 *     `@luminaos/core-objects` — same "checklist/recurrenceRule are embedded
 *     object state" pattern as every other `applyCommandWithFieldValues`
 *     caller.
 *   - `ObjectsController`'s two new routes mirror `setRecurrenceRule`/
 *     `clearRecurrenceRule` exactly: same guard stack
 *     (`SessionAuthGuard`+`WorkspaceMembershipGuard`, class-level), same
 *     `requireActor`/`requireRole` pattern, same `@HttpCode(HttpStatus.OK)`
 *     (200, never 201/204) for BOTH the POST and the DELETE, same `{ object }`
 *     response envelope.
 *   - This PR ALSO wires an external-calendar push side effect
 *     (`TimeBlockPushService`, via a new `CalendarModule` import into
 *     `ObjectsModule`) — but that side effect is a resilient, best-effort,
 *     NEVER-fails-the-request concern, pinned by the SIBLING file
 *     `../calendar/timeblock-push.integration.test.ts`, not this one. This
 *     file only pins the HTTP surface + the domain command's own validation
 *     surfacing as an HTTP error — it deliberately never overrides
 *     `CALENDAR_CONNECTOR` or inspects any push side effect, so a push
 *     failure (or even a slow push) can never make ANY assertion in this file
 *     flaky.
 *
 * ----------------------------------------------------------------------------
 * EXPECTED RED STATE (today): neither route exists on `ObjectsController` —
 * every request below hits Nest's own default "Cannot POST/DELETE ..." 404
 * handler, NOT `AppErrorFilter`. That default handler's body does not carry
 * the `{ error: { code, message } }` shape `AppErrorFilter` produces, so this
 * file's `expectErrorCode` helper (which always additionally asserts
 * `response.body.error.code`) catches even the cases that already expect a
 * literal 404 status for the RIGHT (post-implementation) reason — same
 * "coincidental 404" precedent `checklist-recurrence-http.integration.test.ts`'s
 * own header comment documents.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

/** A syntactically ULID-shaped id that was never actually issued by `newObjectId()` — used for "object does not exist" cases, mirroring `checklist-recurrence-http.integration.test.ts`'s own constant. */
const NONEXISTENT_OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

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

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `timeblock-http-test-user-${String(emailCounter)}@example.com`;
}

describe('F1-T12 PR5d (RED step, part 1/2): POST/DELETE .../timeblock HTTP routes (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
    // in every other integration test file here (AppModule transitively
    // touches `config/env.js`, which `process.exit(1)`s if required env vars
    // are missing at import time).
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

  async function registerUser(): Promise<string> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    return toCookieHeader(response.get('Set-Cookie'));
  }

  async function createWorkspace(cookie: string): Promise<string> {
    const response = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Timeblock HTTP test ${String(emailCounter)}` });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await registerUser();
    const workspaceId = await createWorkspace(cookie);
    return { cookie, workspaceId };
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

  async function softDeleteObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<void> {
    const response = await request(server)
      .delete(objectsUrl(workspaceId, objectId))
      .set('Cookie', cookie);

    expect(response.status).toBe(204);
  }

  function expectErrorCode(response: request.Response, status: number, code: string): void {
    expect(response.status).toBe(status);
    expect((response.body as ApiErrorEnvelope).error.code).toBe(code);
  }

  async function postScheduleTimeblock(
    cookie: string,
    workspaceId: string,
    objectId: string,
    body: unknown,
  ): Promise<request.Response> {
    return request(server)
      .post(`${objectsUrl(workspaceId, objectId)}/timeblock`)
      .set('Cookie', cookie)
      .send(body as Record<string, unknown>);
  }

  async function deleteScheduleTimeblock(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`${objectsUrl(workspaceId, objectId)}/timeblock`)
      .set('Cookie', cookie);
  }

  // ===========================================================================
  // POST .../timeblock (scheduleTimeBlock) — Kabul Kriteri #2
  // ===========================================================================

  describe('POST .../timeblock (scheduleTimeBlock)', () => {
    it('schedules a valid start/end range, response.object.timeBlock matches (200, never 201)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const object = await createTimeblock(cookie, workspaceId, 'Focus block');

      const start = '2026-04-01T09:00:00.000Z';
      const end = '2026-04-01T10:00:00.000Z';

      const response = await postScheduleTimeblock(cookie, workspaceId, object.id, {
        start,
        end,
      });

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(new Date(updated.timeBlock?.start ?? '').getTime()).toBe(new Date(start).getTime());
      expect(new Date(updated.timeBlock?.end ?? '').getTime()).toBe(new Date(end).getTime());
      expect(updated.fieldValues).toEqual(object.fieldValues);
    });

    it('end <= start -> 400 VALIDATION_ERROR (the domain command’s own validation surfaces as HTTP 400)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const object = await createTimeblock(cookie, workspaceId, 'Invalid range block');

      const response = await postScheduleTimeblock(cookie, workspaceId, object.id, {
        start: '2026-04-01T10:00:00.000Z',
        end: '2026-04-01T09:00:00.000Z',
      });

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });

    it('unknown objectId -> 404 NOT_FOUND', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postScheduleTimeblock(cookie, workspaceId, NONEXISTENT_OBJECT_ID, {
        start: '2026-04-01T09:00:00.000Z',
        end: '2026-04-01T10:00:00.000Z',
      });

      expectErrorCode(response, 404, 'NOT_FOUND');
    });

    it('a soft-deleted object -> 409 INVALID_OBJECT_STATE', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const object = await createTimeblock(cookie, workspaceId, 'To be deleted');
      await softDeleteObject(cookie, workspaceId, object.id);

      const response = await postScheduleTimeblock(cookie, workspaceId, object.id, {
        start: '2026-04-01T09:00:00.000Z',
        end: '2026-04-01T10:00:00.000Z',
      });

      expectErrorCode(response, 409, 'INVALID_OBJECT_STATE');
    });
  });

  // ===========================================================================
  // DELETE .../timeblock (clearTimeBlockSchedule)
  // ===========================================================================

  describe('DELETE .../timeblock (clearTimeBlockSchedule)', () => {
    it('clears a previously-scheduled timeblock, response.object.timeBlock is absent (200, never 204)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const object = await createTimeblock(cookie, workspaceId, 'Scheduled then cleared');
      await postScheduleTimeblock(cookie, workspaceId, object.id, {
        start: '2026-04-02T09:00:00.000Z',
        end: '2026-04-02T10:00:00.000Z',
      });

      const response = await deleteScheduleTimeblock(cookie, workspaceId, object.id);

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(updated.timeBlock).toBeUndefined();
      expect(updated.fieldValues).toEqual(object.fieldValues);
    });

    it('clearing when no schedule was ever set -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const object = await createTimeblock(cookie, workspaceId, 'Never scheduled');

      const response = await deleteScheduleTimeblock(cookie, workspaceId, object.id);

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });
  });
});
