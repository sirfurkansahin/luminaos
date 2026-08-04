import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T10 PR5 (RED step) — end-to-end proof of spec item 5 ("Hatırlatıcı"):
 *
 *   "`remindAt` (datetime) + `remindAcknowledged` (boolean) alanları ...
 *   F1-T6 sorgu katmanı üzerinden `remindAt <= now() AND
 *   remindAcknowledged = false` sorgusu açık istemcide 60 sn'de bir çalışır,
 *   süresi geçen hatırlatıcılar uygulama içi bildirim (toast/badge) olarak
 *   gösterilir; kullanıcı görünce `ReminderAcknowledged` olayı üretilir."
 *
 * (Kabul Kriterleri bullet 4: "Hatırlatıcı: `remindAt` geçmiş ve
 * `remindAcknowledged=false` olan görevler sorgu katmanından doğru döner;
 * kullanıcı gördükten sonra `ReminderAcknowledged` olayı üretilip tekrar
 * listelenmediği testli.")
 *
 * ===========================================================================
 * DESIGN VERDICT THIS FILE PINS (verified directly against source, not
 * assumed):
 *
 * 1. `remindAt`/`remindAcknowledged` are ORDINARY CUSTOM FIELDS (F1-T2
 *    mechanism), auto-seeded for `task` alongside `status`/`priority` — NOT
 *    an embedded `LuminaObject` field like `checklist` (PR2) or
 *    `recurrenceRule` (PR4). Those two were deliberately embedded/
 *    non-queryable (no `FieldType` shape fits their structured/
 *    optional-member value). The spec's OWN wording for item 5 explicitly
 *    routes reminders through "F1-T6 sorgu katmanı" (the query/filter
 *    layer), and `apps/server/src/objects/query-builder.ts`'s
 *    `FIXED_COLUMN_KEYS`/`isFixedColumnKey` prove only `title`/`createdAt`/
 *    `updatedAt` are queryable "fixed columns" outside the Custom Fields
 *    mechanism — there is no way to make an arbitrary embedded
 *    `LuminaObject` field queryable without a new DB migration + projection
 *    change (out of scope, and unnecessary here). `remindAt` is fieldType
 *    `'datetime'`, `remindAcknowledged` is fieldType `'checkbox'`, both with
 *    empty config (`packages/core-objects/src/fields/field-type-registry.ts`'s
 *    `emptyConfigSchema`, same as `date`). This makes the spec's compound
 *    filter expressible as a plain `filters: [...]` array against the
 *    EXISTING `POST /workspaces/:workspaceId/objects/query` endpoint (F1-T6
 *    PR-C, see `object-query.integration.test.ts`) with ZERO new
 *    query-layer code:
 *      - `remindAt <= now()` -> `{ field: 'remindAt', operator: 'before',
 *        value: <ISO string> }`. There is no server-side `now()` function in
 *        the query DSL (confirmed against every existing `before`/`after`
 *        date-filter test case in `object-query.integration.test.ts`, which
 *        all pass a literal ISO string as `value`) — the CLIENT is
 *        responsible for computing "now" and passing it explicitly, once per
 *        60s poll per the spec's own client-side polling description. This
 *        file, being server-only, pins the query CONTRACT with a fixed
 *        literal "now" pivot, not the client's 60s timer (out of scope for
 *        an integration test — a `packages/ui`/`apps/web` concern, spec item
 *        6).
 *      - `remindAcknowledged = false` -> `{ field: 'remindAcknowledged',
 *        operator: 'equals', value: false }`. `checkbox`'s only valid
 *        operator is `equals`
 *        (`packages/core-objects/src/fields/query/filter-operators.ts`'s
 *        `CHECKBOX_OPERATORS`) — sufficient for this leg.
 *      - Multiple `filters[]` entries combine with AND (confirmed against
 *        `objects.service.ts`'s `query()`: `and(eq(workspaceId), eq(type),
 *        ne(lifecycle,'deleted'), ...filterPredicates)`) — no special
 *        wiring needed for the compound condition.
 *
 * 2. "kullanıcı görünce `ReminderAcknowledged` olayı üretilir" does NOT
 *    require a new dedicated command/event TYPE in `packages/core-objects`.
 *    Acknowledging a reminder is an ordinary `PATCH
 *    .../objects/:objectId/fields` (`{ values: { remindAcknowledged: true
 *    } }`) through the EXISTING `setFieldValues`/`ObjectsService` path,
 *    which already appends a generic `FieldValueChanged` event —
 *    CLAUDE.md's own event-naming section lists `FieldValueChanged` itself
 *    as an example of an acceptable past-tense event name, so the spec
 *    prose describes the SEMANTIC meaning of that write (the user has
 *    acknowledged the reminder), not a mandate for a literally-new event
 *    `type` string. This mirrors PR1's `status`/`priority` precedent (both
 *    ordinary Custom Fields, no dedicated event type either) more than
 *    PR2/PR4's `checklist`/`recurrenceRule` precedent (which DID need new
 *    commands/events, because they are structured embedded values with no
 *    existing write path). Accordingly this file proves the "no longer
 *    listed" behavior via the SAME generic `PATCH .../fields` call the rest
 *    of the Custom Fields system already uses — it does not invent a new
 *    route or command.
 *
 * ===========================================================================
 * RED STATE (expected, today): `WorkspacesService.seedTaskFields`
 * (`../workspaces/workspaces.service.ts`) does not yet define `remindAt`/
 * `remindAcknowledged` (see `../workspaces/workspaces.integration.test.ts`'s
 * companion RED test for that gap in isolation). Concretely, EVERY test
 * below is expected to fail as follows:
 *
 *  - The `setFieldValues(..., { remindAt: ... })` / `{ remindAcknowledged:
 *    ... }` PATCH calls themselves will fail their OWN `expect(response
 *    .status).toBe(200)` assertion first (before the query step is even
 *    reached) — `ObjectsService.setFieldValues`'s own field-definition
 *    lookup applies the identical "no active definition for this key ->
 *    404 NotFoundError, same as a hidden field" rule
 *    (`object-field-values.integration.test.ts`'s documented precedent) as
 *    `ObjectsService.query`'s `resolveField` does, since NEITHER key has a
 *    field definition yet. Expect `404` with `error.code === 'NOT_FOUND'`
 *    on the PATCH itself, not a query-layer failure — this is the FIRST
 *    thing that breaks, upstream of the actual query assertions this file
 *    is ultimately about.
 *  - If (hypothetically) the PATCH calls were skipped, the subsequent
 *    `queryObjects(...)` call referencing `filters: [{ field: 'remindAt',
 *    ... }, { field: 'remindAcknowledged', ... }]` would ALSO 404
 *    `NOT_FOUND` — this time from `ObjectsService.query`'s own `resolveField`
 *    (`objects.service.ts`), which throws `NotFoundError` for exactly the
 *    same "no active field definition for this key" reason
 *    (`object-query.integration.test.ts`'s own documented "hidden field is
 *    indistinguishable from an undefined one -> 404" precedent applies
 *    identically to an outright NONEXISTENT field — both paths converge on
 *    the same `!definition` branch).
 *  - Confirms this file is red because of the MISSING SEED, not a
 *    query-layer bug — the query layer itself needs zero new code once the
 *    seed exists (see design verdict #1 above).
 * ===========================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectBody {
  id: string;
  type: string;
  title: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface QueryFlatEnvelope {
  objects: ObjectBody[];
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
  return `reminder-query-test-user-${String(emailCounter)}@example.com`;
}

/** Fixed "now" pivot for every test in this file — the client, not the
 * server, is responsible for computing a real `now()` on each 60s poll (see
 * this file's header comment); pinning a literal value here keeps the query
 * CONTRACT deterministic and independent of wall-clock time. */
const NOW_ISO = '2026-06-01T00:00:00.000Z';
const PAST_REMIND_AT = '2020-01-01T00:00:00.000Z';
const FUTURE_REMIND_AT = '2099-01-01T00:00:00.000Z';

describe('Reminder query: remindAt/remindAcknowledged Custom Fields via the F1-T6 query layer (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;

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
  }, 60_000);

  afterAll(async () => {
    await app.close();
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

  /** Registers a fresh owner + a fresh workspace they own. Workspace
   * creation is what triggers `seedTaskFields` (F1-T10 PR1), which per this
   * PR's plan must ALSO seed `remindAt`/`remindAcknowledged` — so, unlike
   * `object-query.integration.test.ts`'s `defineStandardTaskFields` helper,
   * this file deliberately does NOT call the field-definition-creation route
   * for either key: their existence is exactly what is under test. */
  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Reminder Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  function objectsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects`;
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

  /** Mirrors `object-query.integration.test.ts`'s `setFieldValues` helper —
   * asserts `200` so a red failure here (today: `404 NOT_FOUND`, per this
   * file's header comment) surfaces immediately at the PATCH step, not
   * confusingly deep inside a later query assertion. */
  async function setFieldValues(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const response = await request(server)
      .patch(`${objectsUrl(workspaceId)}/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });

    expect(response.status).toBe(200);
  }

  /** The exact compound filter the spec's item 5 describes:
   * `remindAt <= now() AND remindAcknowledged = false`, expressed as the
   * F1-T6 query DSL's `before` (strict `<`, per `query-builder.ts`'s
   * `buildDatePredicate`) + `equals` operators, combined implicitly with
   * AND. */
  function dueReminderQuery(cookie: string, workspaceId: string): request.Test {
    return request(server)
      .post(`${objectsUrl(workspaceId)}/query`)
      .set('Cookie', cookie)
      .send({
        objectType: 'task',
        filters: [
          { field: 'remindAt', operator: 'before', value: NOW_ISO },
          { field: 'remindAcknowledged', operator: 'equals', value: false },
        ],
      });
  }

  it('a task with a PAST remindAt, never explicitly acknowledged, IS returned by the due-reminder query — and is no longer returned once ReminderAcknowledged (a PATCH setting remindAcknowledged:true) is recorded', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const task = await createTask(cookie, workspaceId, 'Past, unacknowledged reminder');
    await setFieldValues(cookie, workspaceId, task.id, { remindAt: PAST_REMIND_AT });
    // `remindAcknowledged` deliberately left UNTOUCHED here — the spec's
    // common-case workflow: the seed's own `defaultValue: false` (see
    // `../workspaces/workspaces.integration.test.ts`) is what must make
    // this task visible below, not an explicit write.

    const dueResponse = await dueReminderQuery(cookie, workspaceId);
    expect(dueResponse.status).toBe(200);
    expect((dueResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toContain(task.id);

    // "kullanıcı görünce `ReminderAcknowledged` olayı üretilir" — modeled as
    // the ordinary generic `PATCH .../fields` write (see this file's header
    // comment, design verdict #2).
    await setFieldValues(cookie, workspaceId, task.id, { remindAcknowledged: true });

    const afterAckResponse = await dueReminderQuery(cookie, workspaceId);
    expect(afterAckResponse.status).toBe(200);
    expect((afterAckResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).not.toContain(
      task.id,
    );
  });

  it('a task with a PAST remindAt that was acknowledged from the very start (remindAcknowledged explicitly true) is never returned', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const task = await createTask(cookie, workspaceId, 'Past, pre-acknowledged reminder');
    await setFieldValues(cookie, workspaceId, task.id, {
      remindAt: PAST_REMIND_AT,
      remindAcknowledged: true,
    });

    const dueResponse = await dueReminderQuery(cookie, workspaceId);
    expect(dueResponse.status).toBe(200);
    expect((dueResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).not.toContain(task.id);
  });

  it('a task with a FUTURE remindAt (not yet due) is never returned by the due-reminder query, even while unacknowledged', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const task = await createTask(cookie, workspaceId, 'Future reminder, not yet due');
    await setFieldValues(cookie, workspaceId, task.id, { remindAt: FUTURE_REMIND_AT });

    const dueResponse = await dueReminderQuery(cookie, workspaceId);
    expect(dueResponse.status).toBe(200);
    expect((dueResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).not.toContain(task.id);
  });

  it('a task with no remindAt set at all is never returned by the due-reminder query (the "before" comparison has nothing to compare)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const task = await createTask(cookie, workspaceId, 'No reminder set');

    const dueResponse = await dueReminderQuery(cookie, workspaceId);
    expect(dueResponse.status).toBe(200);
    expect((dueResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).not.toContain(task.id);
  });
});
