import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { events } from '../db/schema/events.js';
import { objectsView } from '../db/schema/objects-view.js';
import { TaskRecurrenceService } from '../recurrence/task-recurrence.service.js';

import type { Database } from '../db/client.js';
import type { GenerateNextOccurrenceInput } from '../recurrence/task-recurrence.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T10 PR4 (RED step) — `ObjectsService.setFieldValues` -> the false->true
 * `status`/`isDone` transition-DETECTION (ADR-0010 §"(f)") -> the wiring
 * call into `TaskRecurrenceService.generateNextOccurrence` (ADR-0010 §"(d)
 * Orkestrasyon yeri": "kendi olay ekleme (`append`) çağrısı BAŞARIYLA
 * tamamlandıktan SONRA bu yeni servise TEK, dar, açık bir metot çağrısı
 * yapar"). Closes the remaining half of spec bullet 3
 * (`docs/specs/F1-E3/F1-T10-gorev-deneyimi.md`):
 *
 *   "`status` alanı `isDone=true` seçeneğine geçince tam olarak bir yeni
 *   yinelenen görev üretildiği ... testli."
 *
 * Same Testcontainers Postgres 16 + Redis 7 pair, dynamic
 * `import('../app.module.js')` AFTER env vars are set,
 * `toCookieHeader`/`registerUser`/`createWorkspace` conventions as every
 * other integration test file here (self-contained, duplicated rather than
 * imported).
 *
 * ============================================================================
 * RED STATE (expected, today): `ObjectsService.setFieldValues`
 * (`./objects.service.ts`) has NO knowledge of `TaskRecurrenceService` at
 * all — `ObjectsModule` (`./objects.module.ts`) does not import/provide it,
 * and nothing calls `detectStatusDoneTransition`/`generateNextOccurrence`
 * from the field-value write path. Concretely: every `PATCH
 * .../objects/:objectId/fields` request below SUCCEEDS exactly as it does
 * today (200, `status` genuinely flips in the response body) — this file
 * does NOT expect any HTTP-level failure. What is missing is the SIDE
 * EFFECT: `generateNextOccurrenceMock` (this file's own spy, installed via
 * `overrideProvider(TaskRecurrenceService)`) is never called, so every
 * `expect(generateNextOccurrenceMock).toHaveBeenCalledTimes(1)`-shaped
 * assertion below fails with "expected 1, received 0". This is the correct
 * red: the FEATURE (the wiring itself) doesn't exist yet, not a test-logic
 * bug. `implementer` must (a) create `./status-done-transition.ts`
 * (`./status-done-transition.test.ts` pins its own contract, a separate file
 * in this PR), (b) call it from `setFieldValues` for every entry whose
 * `fieldKey === 'status'`, AFTER this method's own `eventStore.append(...)`
 * call has resolved (never before — a call that never durably lands must
 * never trigger recurrence generation), (c) on a genuine transition, call
 * `TaskRecurrenceService.generateNextOccurrence` with `causationEventId`
 * equal to the just-appended `status` `FieldValueChanged` event's OWN `id`
 * (not any other event in the same batch — a formula-recompute event
 * appended in the same call must never be mistaken for the causation event),
 * `sourceObjectId: objectId`, and `nextOccurrence: { title: <the object's
 * CURRENT title>, fieldValues: <this write's resulting fieldValues, with
 * `status` reset to the first non-`isDone` option, per ADR-0010 §(g)> }`,
 * and (d) add `TaskRecurrenceService` (+ its `EventStoreModule` dependency,
 * already imported by `ObjectsModule`) to `ObjectsModule`'s `providers` to
 * turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * WHY `overrideProvider(TaskRecurrenceService)`, not a real call:
 *
 * This file mocks `TaskRecurrenceService.generateNextOccurrence` entirely —
 * it does NOT assert on the real new `task` object/`recurrenceOf` relation
 * `TaskRecurrenceService` itself would produce (that full cross-stream
 * behavior, including idempotency, is already exhaustively covered by
 * `../recurrence/task-recurrence.service.test.ts`, a separate, already-green
 * PR3 test file this PR must not touch). This file's ONLY job is to pin
 * `ObjectsService.setFieldValues`'s own CALLER-side contract: does it call
 * the service, how many times, and with what exact arguments. Overriding the
 * provider with a `vi.fn()`-backed stub is what makes that call boundary
 * observable/assertable without needing to also reverse-engineer
 * `TaskRecurrenceService`'s own deterministic-id output shape here.
 *
 * Today, BEFORE `ObjectsModule` provides `TaskRecurrenceService` at all,
 * `overrideProvider(TaskRecurrenceService).useValue(...)` is a harmless
 * no-op (there is nothing in the compiled module graph to override) — the
 * app boots and every PATCH request below behaves exactly as it does without
 * this override present. This is precisely why the red state above is an
 * ASSERTION failure ("received 0 calls"), not a startup/compile error.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectBody {
  id: string;
  type: string;
  title: string;
  workspaceId: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface StoredEventPayload {
  fieldKey?: string;
  value?: unknown;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `object-recurrence-trigger-test-user-${String(emailCounter)}@example.com`;
}

const generateNextOccurrenceMock = vi.fn<
  (
    input: GenerateNextOccurrenceInput,
  ) => ReturnType<TaskRecurrenceService['generateNextOccurrence']>
>(async () =>
  Promise.resolve({
    object: {
      id: 'fake-generated-object-id',
      type: 'task',
      workspaceId: 'fake-workspace-id',
      title: 'fake next occurrence',
      createdBy: 'fake-actor',
      createdAt: new Date(),
      updatedAt: new Date(),
      lifecycle: 'active',
      checklist: [],
    },
    fieldValues: {},
    relation: {
      id: 'fake-relation-id',
      workspaceId: 'fake-workspace-id',
      fromId: 'fake-source-id',
      toId: 'fake-generated-object-id',
      kind: 'recurrenceOf',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }),
);

describe('status -> isDone triggers TaskRecurrenceService (real Postgres + real HTTP via Testcontainers + supertest, TaskRecurrenceService mocked)', () => {
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

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TaskRecurrenceService)
      .useValue({ generateNextOccurrence: generateNextOccurrenceMock })
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

  afterEach(() => {
    generateNextOccurrenceMock.mockClear();
  });

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
      .send({ name: `Recurrence trigger test ${String(emailCounter)}` });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await registerUser();
    const workspaceId = await createWorkspace(cookie);
    return { cookie, workspaceId };
  }

  async function createTask(
    cookie: string,
    workspaceId: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  async function patchFields(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });

    expect(response.status).toBe(200);
    return (response.body as ObjectEnvelope).object;
  }

  /**
   * Finds the `id` of the specific `FieldValueChanged` event on `objectId`'s
   * own stream whose payload set `status` to `'done'` — the exact event
   * `ObjectsService.setFieldValues` is expected to pass as
   * `causationEventId` (ADR-0010 §"(c) Layer B"). Reads the raw `events`
   * table directly (same `rawDb` access convention as every other
   * integration test file here) rather than assuming any particular id
   * shape.
   */
  async function findStatusDoneEventId(objectId: string): Promise<string> {
    const [objectRow] = await rawDb
      .select({ streamId: objectsView.streamId })
      .from(objectsView)
      .where(eq(objectsView.id, objectId))
      .limit(1);

    if (!objectRow) {
      throw new Error(`object ${objectId} not found in objects_view`);
    }

    const rows = await rawDb
      .select()
      .from(events)
      .where(and(eq(events.streamId, objectRow.streamId), eq(events.type, 'FieldValueChanged')))
      .orderBy(desc(events.version));

    const match = rows.find((row) => {
      const payload = row.payload as StoredEventPayload;
      return payload.fieldKey === 'status' && payload.value === 'done';
    });

    if (!match) {
      throw new Error(`no status->done FieldValueChanged event found for object ${objectId}`);
    }

    return match.id;
  }

  it('a genuine todo -> done transition calls TaskRecurrenceService.generateNextOccurrence exactly once, with the correct causationEventId/sourceObjectId/nextOccurrence', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const task = await createTask(cookie, workspaceId, 'Water the plants');

    // Explicit non-done baseline (status has no seeded default value, per
    // `workspaces.service.ts`'s seed — this establishes a real PRIOR value
    // rather than relying on the "absent -> done" edge case).
    await patchFields(cookie, workspaceId, task.id, { status: 'todo' });
    expect(generateNextOccurrenceMock).not.toHaveBeenCalled();

    // A non-status edit must never trigger.
    await patchFields(cookie, workspaceId, task.id, { priority: 'high' });
    expect(generateNextOccurrenceMock).not.toHaveBeenCalled();

    // Still not done -> not a transition.
    await patchFields(cookie, workspaceId, task.id, { status: 'doing' });
    expect(generateNextOccurrenceMock).not.toHaveBeenCalled();

    // The genuine false -> true transition.
    await patchFields(cookie, workspaceId, task.id, { status: 'done' });

    expect(generateNextOccurrenceMock).toHaveBeenCalledTimes(1);

    const expectedCausationEventId = await findStatusDoneEventId(task.id);
    const [callArg] = generateNextOccurrenceMock.mock.calls[0] as [
      {
        workspaceId: string;
        sourceObjectId: string;
        causationEventId: string;
        nextOccurrence: { title: string; fieldValues: Record<string, unknown> };
      },
    ];

    expect(callArg.workspaceId).toBe(workspaceId);
    expect(callArg.sourceObjectId).toBe(task.id);
    expect(callArg.causationEventId).toBe(expectedCausationEventId);
    expect(callArg.nextOccurrence.title).toBe('Water the plants');
    expect(callArg.nextOccurrence.fieldValues.status).toBe('todo');
    expect(callArg.nextOccurrence.fieldValues.priority).toBe('high');
  });

  it('editing another field while status is already "done" does not re-trigger generation (true -> true is not a transition)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const task = await createTask(cookie, workspaceId, 'Renew the domain');

    await patchFields(cookie, workspaceId, task.id, { status: 'done' });
    expect(generateNextOccurrenceMock).toHaveBeenCalledTimes(1);
    generateNextOccurrenceMock.mockClear();

    await patchFields(cookie, workspaceId, task.id, { priority: 'urgent' });

    expect(generateNextOccurrenceMock).not.toHaveBeenCalled();
  });

  it('setting status directly to "done" from its never-set (absent) value counts as a false -> true transition and triggers exactly once', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const task = await createTask(cookie, workspaceId, 'File the taxes');

    await patchFields(cookie, workspaceId, task.id, { status: 'done' });

    expect(generateNextOccurrenceMock).toHaveBeenCalledTimes(1);
  });

  it('un-completing a task (done -> todo) does not itself trigger generation', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const task = await createTask(cookie, workspaceId, 'Draft the newsletter');

    await patchFields(cookie, workspaceId, task.id, { status: 'done' });
    expect(generateNextOccurrenceMock).toHaveBeenCalledTimes(1);
    generateNextOccurrenceMock.mockClear();

    await patchFields(cookie, workspaceId, task.id, { status: 'todo' });

    expect(generateNextOccurrenceMock).not.toHaveBeenCalled();
  });

  it('security-reviewer regression: a TaskRecurrenceService failure does not fail the PATCH response for the already-committed status write', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const task = await createTask(cookie, workspaceId, 'Pay the invoice');

    generateNextOccurrenceMock.mockRejectedValueOnce(new Error('boom: recurrence write failed'));

    const updated = await patchFields(cookie, workspaceId, task.id, { status: 'done' });

    expect(updated.fieldValues.status).toBe('done');
    expect(generateNextOccurrenceMock).toHaveBeenCalledTimes(1);
  });
});
