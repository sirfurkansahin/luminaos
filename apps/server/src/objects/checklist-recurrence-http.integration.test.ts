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
 * F1-T10 PR6b (RED step) — plan `precious-roaming-harbor.md`, section
 * "PR6b — Backend: checklist + recurrence-rule HTTP route'ları" / "Karar 1 —
 * HTTP route şekli":
 *
 *   POST   /workspaces/:workspaceId/objects/:objectId/checklist/items                 body: { text }
 *   POST   /workspaces/:workspaceId/objects/:objectId/checklist/items/:itemId/toggle  (no body)
 *   DELETE /workspaces/:workspaceId/objects/:objectId/checklist/items/:itemId
 *   POST   /workspaces/:workspaceId/objects/:objectId/checklist/reorder               body: { orderedItemIds }
 *   POST   /workspaces/:workspaceId/objects/:objectId/recurrence-rule                 body: RecurrenceRule
 *   DELETE /workspaces/:workspaceId/objects/:objectId/recurrence-rule
 *
 * None of these six routes exist on `ObjectsController` today (verified by
 * reading `objects.controller.ts` in full) -- `packages/core-objects`'s pure
 * commands (`checklist-commands.ts`, `recurrence-rule-commands.ts`, both PR2/
 * PR4, already fully unit-tested in isolation) are simply never invoked from
 * any HTTP path. This file is the RED step for wiring them up.
 *
 * ============================================================================
 * EXPECTED RED STATE (today, before `implementer` adds the 3 DTO schemas +
 * `ObjectsService`'s 6 new methods/`applyCommandWithFieldValues` helper + the
 * 6 new `ObjectsController` route handlers):
 *
 *   Every one of these 6 routes is UNKNOWN to Nest's router today. Every
 *   request below hits Nest's own default "Cannot POST/DELETE ..." 404
 *   handler -- NOT `AppErrorFilter`. That default handler's response body
 *   does NOT have the `{ error: { code, message } }` shape `AppErrorFilter`
 *   produces (see `app-error.filter.ts`), so:
 *
 *     - Every SUCCESS-path assertion below (expecting 200 + a real `{ object }`
 *       body) fails as a plain status-code mismatch (404 received, 200/201
 *       expected) or a body-shape mismatch -- an unambiguous "route doesn't
 *       exist yet" red.
 *     - Every ERROR-path assertion below that itself expects a 404 (the
 *       "unknown object" case) would, at this exact pre-implementation
 *       moment, COINCIDENTALLY get a 404 status too -- but for the WRONG
 *       reason (missing route, not `NotFoundError`). Same precedent as
 *       `object-query.integration.test.ts`'s and
 *       `checklist-recurrence-projection.integration.test.ts`'s own header
 *       comments document for this exact situation. This file's
 *       `expectErrorCode` helper ALWAYS additionally asserts
 *       `response.body.error.code` (e.g. `'NOT_FOUND'`/`'VALIDATION_ERROR'`/
 *       `'INVALID_OBJECT_STATE'`), which Nest's default 404 body does not
 *       carry -- so that coincidence is still caught and this red is red for
 *       the right reason, on every single error-path assertion, not just the
 *       404 one.
 *
 * `implementer`'s job (this same PR): create the 3 DTO schema files
 * (`dto/add-checklist-item.schema.ts`, `dto/reorder-checklist.schema.ts`,
 * `dto/set-recurrence-rule.schema.ts`), add `ObjectsService`'s 6 new methods
 * routed through a new private `applyCommandWithFieldValues` helper
 * (mirrors the existing private `applyCommand` -- lookupStreamId ->
 * eventStore.readStream -> replayObject -> run the pure command -> wrapDrafts
 * -> eventStore.append -> projectionRunner.catchUp -> replayObject again --
 * PLUS replaying/attaching+role-filtering `fieldValues` the same way
 * `setFieldValues` does, minus the formula-recompute step), and add the 6
 * `ObjectsController` route handlers (same `WorkspaceMembershipGuard` +
 * `requireActor`/`requireRole` pattern as `rename`/`archive`/`restore`, no
 * new permission gate).
 *
 * STATUS-CODE CONVENTION PINNED BY THIS FILE (not explicitly spelled out
 * character-for-character in Karar 1's route table, but the closest
 * consistent reading of "mevcut archive/restore/refresh action-route deseni
 * ... birebir taklit edilir" -- those three are all `@HttpCode(HttpStatus.OK)`
 * `POST`s that return a body): every one of these 6 routes, POST and DELETE
 * alike, responds 200 with a `{ object }` body (never 201/204 -- unlike
 * `POST /objects` (201, a genuinely new top-level resource) and unlike
 * `DELETE /objects/:objectId` (204, no body at all, an actual hard-delete
 * action) -- these 6 mutate EXISTING embedded object state and always need to
 * hand back the fresh `{ object }`, so 204 is never appropriate here).
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

/** `checklist-commands.ts`'s own `CHECKLIST_ITEM_LIMIT` constant, mirrored here (not imported -- it's a private, unexported module constant). */
const CHECKLIST_ITEM_LIMIT = 200;

/** A syntactically ULID-shaped id that was never actually issued by `newObjectId()` -- used for "object does not exist" cases. */
const NONEXISTENT_OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

interface ChecklistItemBody {
  id: string;
  text: string;
  done: boolean;
  order: number;
}

interface RecurrenceRuleBody {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: number[];
  endDate?: string;
}

interface ObjectBody {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  checklist: ChecklistItemBody[];
  recurrenceRule?: RecurrenceRuleBody;
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
  return `checklist-recurrence-http-test-user-${String(emailCounter)}@example.com`;
}

describe('F1-T10 PR6b (RED step): checklist + recurrence-rule HTTP write routes (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the
    // established convention in every other integration test file here.
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
      .send({ name: `Checklist/recurrence HTTP test ${String(emailCounter)}` });

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

  async function createTask(
    cookie: string,
    workspaceId: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(objectsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  async function softDeleteTask(
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

  // ---------------------------------------------------------------------
  // Raw route callers -- deliberately return the raw `supertest.Response`
  // (no built-in status assertion), so the same helper serves both
  // success-path and error-path tests.
  // ---------------------------------------------------------------------

  async function postAddChecklistItem(
    cookie: string,
    workspaceId: string,
    objectId: string,
    text: unknown,
  ): Promise<request.Response> {
    return request(server)
      .post(`${objectsUrl(workspaceId, objectId)}/checklist/items`)
      .set('Cookie', cookie)
      .send({ text });
  }

  async function postToggleChecklistItem(
    cookie: string,
    workspaceId: string,
    objectId: string,
    itemId: string,
  ): Promise<request.Response> {
    return request(server)
      .post(`${objectsUrl(workspaceId, objectId)}/checklist/items/${itemId}/toggle`)
      .set('Cookie', cookie)
      .send();
  }

  async function deleteChecklistItem(
    cookie: string,
    workspaceId: string,
    objectId: string,
    itemId: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`${objectsUrl(workspaceId, objectId)}/checklist/items/${itemId}`)
      .set('Cookie', cookie);
  }

  async function postReorderChecklist(
    cookie: string,
    workspaceId: string,
    objectId: string,
    orderedItemIds: unknown,
  ): Promise<request.Response> {
    return request(server)
      .post(`${objectsUrl(workspaceId, objectId)}/checklist/reorder`)
      .set('Cookie', cookie)
      .send({ orderedItemIds });
  }

  async function postSetRecurrenceRule(
    cookie: string,
    workspaceId: string,
    objectId: string,
    body: unknown,
  ): Promise<request.Response> {
    return request(server)
      .post(`${objectsUrl(workspaceId, objectId)}/recurrence-rule`)
      .set('Cookie', cookie)
      .send(body as Record<string, unknown>);
  }

  async function deleteRecurrenceRule(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`${objectsUrl(workspaceId, objectId)}/recurrence-rule`)
      .set('Cookie', cookie);
  }

  // ===========================================================================
  // POST .../checklist/items (addChecklistItem)
  // ===========================================================================

  describe('POST .../checklist/items (addChecklistItem)', () => {
    it('server-generates a ULID-shaped itemId (client sends only { text }); two sequential adds get order 0 then 1, different itemIds, and fieldValues survive untouched', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Grocery run');

      const firstResponse = await postAddChecklistItem(cookie, workspaceId, task.id, 'Buy milk');
      expect(firstResponse.status).toBe(200);
      const afterFirst = (firstResponse.body as ObjectEnvelope).object;

      expect(afterFirst.checklist).toHaveLength(1);
      const [firstItem] = afterFirst.checklist;
      expect(firstItem).toBeDefined();
      expect(firstItem?.text).toBe('Buy milk');
      expect(firstItem?.done).toBe(false);
      expect(firstItem?.order).toBe(0);
      // Server-generated itemId: a 26-char Crockford-base32 ULID, per
      // `packages/core-objects/src/id.ts`'s `newObjectId()` (the SAME
      // mechanism `objectId` itself uses) -- the client never supplied one.
      expect(firstItem?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // The checklist mutation must not blow away the fieldValues half of
      // the response -- the specific regression this plan calls out.
      expect(afterFirst.fieldValues).toEqual(task.fieldValues);

      const secondResponse = await postAddChecklistItem(cookie, workspaceId, task.id, 'Buy eggs');
      expect(secondResponse.status).toBe(200);
      const afterSecond = (secondResponse.body as ObjectEnvelope).object;

      expect(afterSecond.checklist).toHaveLength(2);
      const [, secondItem] = afterSecond.checklist;
      expect(secondItem).toBeDefined();
      expect(secondItem?.text).toBe('Buy eggs');
      expect(secondItem?.order).toBe(1);
      expect(secondItem?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(secondItem?.id).not.toBe(firstItem?.id);
      expect(afterSecond.fieldValues).toEqual(task.fieldValues);
    });

    it('unknown objectId -> 404 NOT_FOUND', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postAddChecklistItem(
        cookie,
        workspaceId,
        NONEXISTENT_OBJECT_ID,
        'Buy milk',
      );

      expectErrorCode(response, 404, 'NOT_FOUND');
    });

    it('a soft-deleted object -> 409 INVALID_OBJECT_STATE', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'To be deleted');
      await softDeleteTask(cookie, workspaceId, task.id);

      const response = await postAddChecklistItem(cookie, workspaceId, task.id, 'Buy milk');

      expectErrorCode(response, 409, 'INVALID_OBJECT_STATE');
    });
  });

  // ===========================================================================
  // POST .../checklist/items/:itemId/toggle (toggleChecklistItem)
  // ===========================================================================

  describe('POST .../checklist/items/:itemId/toggle (toggleChecklistItem)', () => {
    it('flips done false -> true, response carries fresh fieldValues', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Weekly review');
      const added = await postAddChecklistItem(cookie, workspaceId, task.id, 'Write summary');
      const itemId = (added.body as ObjectEnvelope).object.checklist[0]?.id;
      expect(itemId).toBeDefined();

      const response = await postToggleChecklistItem(
        cookie,
        workspaceId,
        task.id,
        itemId as string,
      );

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(updated.checklist[0]?.done).toBe(true);
      expect(updated.fieldValues).toEqual(task.fieldValues);
    });

    it('unknown itemId -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Weekly review');

      const response = await postToggleChecklistItem(
        cookie,
        workspaceId,
        task.id,
        'not-a-real-item-id',
      );

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });
  });

  // ===========================================================================
  // DELETE .../checklist/items/:itemId (removeChecklistItem)
  // ===========================================================================

  describe('DELETE .../checklist/items/:itemId (removeChecklistItem)', () => {
    it('removes exactly the targeted item, response carries fresh fieldValues', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Cleanup task');
      const afterFirst = await postAddChecklistItem(cookie, workspaceId, task.id, 'Keep me');
      const keepId = (afterFirst.body as ObjectEnvelope).object.checklist[0]?.id as string;
      const afterSecond = await postAddChecklistItem(cookie, workspaceId, task.id, 'Remove me');
      const removeId = (afterSecond.body as ObjectEnvelope).object.checklist[1]?.id as string;

      const response = await deleteChecklistItem(cookie, workspaceId, task.id, removeId);

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(updated.checklist.map((item) => item.id)).toEqual([keepId]);
      expect(updated.fieldValues).toEqual(task.fieldValues);
    });

    it('unknown itemId -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Cleanup task');

      const response = await deleteChecklistItem(
        cookie,
        workspaceId,
        task.id,
        'not-a-real-item-id',
      );

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });
  });

  // ===========================================================================
  // POST .../checklist/reorder (reorderChecklistItem)
  // ===========================================================================

  describe('POST .../checklist/reorder (reorderChecklistItem)', () => {
    it("reorders the array AND resequences each item's own order field to match orderedItemIds, fieldValues untouched", async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Reorder task');

      const r1 = await postAddChecklistItem(cookie, workspaceId, task.id, 'First');
      const id1 = (r1.body as ObjectEnvelope).object.checklist[0]?.id as string;
      const r2 = await postAddChecklistItem(cookie, workspaceId, task.id, 'Second');
      const id2 = (r2.body as ObjectEnvelope).object.checklist[1]?.id as string;
      const r3 = await postAddChecklistItem(cookie, workspaceId, task.id, 'Third');
      const id3 = (r3.body as ObjectEnvelope).object.checklist[2]?.id as string;

      const response = await postReorderChecklist(cookie, workspaceId, task.id, [id3, id1, id2]);

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(updated.checklist.map((item) => item.id)).toEqual([id3, id1, id2]);
      expect(updated.checklist.map((item) => item.order)).toEqual([0, 1, 2]);
      expect(updated.fieldValues).toEqual(task.fieldValues);
    });

    it('an invalid permutation (unknown id mixed in) -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Reorder task');
      const added = await postAddChecklistItem(cookie, workspaceId, task.id, 'Only item');
      const itemId = (added.body as ObjectEnvelope).object.checklist[0]?.id as string;

      const response = await postReorderChecklist(cookie, workspaceId, task.id, [
        itemId,
        'not-a-real-item-id',
      ]);

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });
  });

  // ===========================================================================
  // 200-item checklist cap (addChecklistItem)
  // ===========================================================================

  describe('checklist item cap', () => {
    it(`adding a ${String(CHECKLIST_ITEM_LIMIT + 1)}th item -> 400 VALIDATION_ERROR`, async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Capacity task');

      for (let index = 0; index < CHECKLIST_ITEM_LIMIT; index += 1) {
        const response = await postAddChecklistItem(
          cookie,
          workspaceId,
          task.id,
          `item ${String(index)}`,
        );
        expect(response.status).toBe(200);
      }

      const overflowResponse = await postAddChecklistItem(
        cookie,
        workspaceId,
        task.id,
        'one too many',
      );

      expectErrorCode(overflowResponse, 400, 'VALIDATION_ERROR');
    }, 120_000);
  });

  // ===========================================================================
  // POST .../recurrence-rule (setRecurrenceRule)
  // ===========================================================================

  describe('POST .../recurrence-rule (setRecurrenceRule)', () => {
    it('sets a full rule (byWeekday + endDate), response carries fresh fieldValues', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Weekly report');

      const response = await postSetRecurrenceRule(cookie, workspaceId, task.id, {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [1, 3, 5],
        endDate: '2027-01-01',
      });

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(updated.recurrenceRule).toEqual({
        frequency: 'weekly',
        interval: 1,
        byWeekday: [1, 3, 5],
        endDate: '2027-01-01',
      });
      expect(updated.fieldValues).toEqual(task.fieldValues);
    });

    it('interval < 1 -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Weekly report');

      const response = await postSetRecurrenceRule(cookie, workspaceId, task.id, {
        frequency: 'daily',
        interval: 0,
      });

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });
  });

  // ===========================================================================
  // DELETE .../recurrence-rule (clearRecurrenceRule)
  // ===========================================================================

  describe('DELETE .../recurrence-rule (clearRecurrenceRule)', () => {
    it('clears a previously-set rule, response.recurrenceRule is absent, fieldValues untouched', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Monthly report');
      await postSetRecurrenceRule(cookie, workspaceId, task.id, {
        frequency: 'monthly',
        interval: 1,
      });

      const response = await deleteRecurrenceRule(cookie, workspaceId, task.id);

      expect(response.status).toBe(200);
      const updated = (response.body as ObjectEnvelope).object;
      expect(updated.recurrenceRule).toBeUndefined();
      expect(updated.fieldValues).toEqual(task.fieldValues);
    });

    it('clearing when no rule was ever set -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Never had a rule');

      const response = await deleteRecurrenceRule(cookie, workspaceId, task.id);

      expectErrorCode(response, 400, 'VALIDATION_ERROR');
    });
  });
});
