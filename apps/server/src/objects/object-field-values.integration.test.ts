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
 * F1-T2 PR-C (final PR of F1-T2): server-side integration of custom FIELD
 * VALUES on Lumina Objects, plus role-based read filtering. Closes:
 *
 *  - AC #3: "guest rolü `edit` izni olmayan alana yazamaz; `hidden` alan
 *    guest yanıtında görünmez."
 *  - AC #4 (HTTP half): "Default değerler ObjectCreated akışında uygulanır
 *    ve replay'de korunur" — `POST .../objects` must carry field defaults in
 *    its OWN response, no extra round trip.
 *  - AC #5 (API half): "Alan tanımı değişince mevcut değerler bozulmaz" —
 *    updating a field definition after a value was recorded must not
 *    corrupt the already-stored value.
 *
 * Same Testcontainers/`AppModule`/supertest/`toCookieHeader`/
 * `addMemberWithRole`-via-raw-DB pattern as
 * `../objects/objects.integration.test.ts` and
 * `../fields/field-definitions-security.integration.test.ts` (both borrowed
 * from here — this file needs both object routes and field-definition
 * routes).
 *
 * ============================================================================
 * RED STATE (expected, today): none of this exists yet.
 *
 *  - `PATCH /workspaces/:workspaceId/objects/:objectId/fields` is a BRAND
 *    NEW route — `ObjectsController` has no handler for it today, so every
 *    request to it below is expected to 404 via Nest's own default
 *    "Cannot PATCH ..." handler (no matching route at all), NOT via
 *    `AppErrorFilter` mapping an `AppError`.
 *  - `POST /workspaces/:workspaceId/objects` and
 *    `GET /workspaces/:workspaceId/objects[/:objectId]` DO already exist
 *    (F1-T1), but their response bodies today have no `fieldValues` key at
 *    all (`ObjectsService.toLuminaObject`/`LuminaObject` don't carry field
 *    values yet, and `objects_view` has no `field_values` column). So
 *    assertions like `expect(object.fieldValues[key]).toBe(...)` will fail
 *    with "Cannot read properties of undefined" — again, a sign the FEATURE
 *    doesn't exist yet, not a test-logic bug. Once `implementer` adds the
 *    `field_values jsonb` column + wires `ObjectsService`/`ObjectsController`
 *    per this file's pinned contract, these same requests should return the
 *    shapes asserted below.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `object` response shape now includes a NEW `fieldValues` key (camelCase,
 * sibling to `title`/`lifecycle`/etc.), a flat `{ [fieldKey]: value }` map —
 * chosen because `objects_view.field_values` is already keyed by `fieldKey`
 * at the storage layer (per the plan's projection design), so the API shape
 * mirrors storage 1:1 with no extra nesting:
 *
 *   { object: { id, type, title, workspaceId, createdBy, createdAt,
 *               updatedAt, lifecycle, fieldValues: { [fieldKey]: value } } }
 *
 * `fieldValues` is ALWAYS present (defaulting to `{}` for an object with no
 * field values yet — the column's own `DEFAULT '{}'`), and any field whose
 * `permissions[callerRole] === 'hidden'` is fully ABSENT from this map for
 * that caller (not `null`, not omitted-but-`undefined` — the key itself
 * does not exist in the JSON body). This applies to BOTH `GET
 * /workspaces/:workspaceId/objects/:objectId` (single) and `GET
 * /workspaces/:workspaceId/objects` (list, per-object).
 *
 * `POST /workspaces/:workspaceId/objects` (create) applies active field
 * defaults atomically: the 201 response's `object.fieldValues` already
 * contains every active field definition's `defaultValue` for the created
 * `objectType`, with NO separate `setFieldValues` call needed.
 *
 * NEW: `PATCH /workspaces/:workspaceId/objects/:objectId/fields`
 *   body:  `{ values: { [fieldKey]: value, ... } }` (one or more keys —
 *          batch, all-or-nothing, per PR-A's `setFieldValues`)
 *   ->  200 `{ object: {...} }` (fresh `fieldValues` reflected,
 *       read-your-writes, no extra GET needed)
 *   ->  403 (`ForbiddenError`) if the caller's role does not have `'edit'`
 *       on ANY of the submitted `fieldKey`s (`'view'` or `'hidden'` both
 *       count as "no edit")
 *   ->  404 (`NotFoundError`) if a submitted `fieldKey` has no matching
 *       ACTIVE field definition for this object's `objectType`
 *   ->  400 (`ValidationError`) if any submitted value fails
 *       `validateFieldValue` for its field's type/config
 *   ->  batch atomicity: if the body has 2+ keys and ANY one of them is
 *       invalid (403/404/400 reason), NONE of the values are applied — a
 *       follow-up `GET` must show every field unchanged from before the
 *       request, including the ones that WOULD have been individually valid.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface FieldDefinitionBody {
  id: string;
  key: string;
  objectType: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface ObjectBody {
  id: string;
  type: string;
  title: string;
  workspaceId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface ObjectListEnvelope {
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

const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

/** Every role can view, but only owner/admin can edit — used for the
 * "guest has view, not edit" 403 scenario. */
const VIEW_FOR_GUEST_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'view',
};

/** Fully hidden from guests — used for the hidden-filtering scenario. */
const HIDDEN_FOR_GUEST_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'view',
  guest: 'hidden',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `object-field-values-test-user-${String(emailCounter)}@example.com`;
}

describe('Lumina Object field VALUES + role-based read filtering (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  /** Registers a fresh user + a fresh workspace they own (owner role), in
   * one call. */
  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Field Values Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  /** Registers a fresh user, adds them to `workspaceId` with `role` via a
   * raw DB insert (mirrors `field-definitions-security.integration.test.ts`'s
   * exact helper), and returns their session cookie header. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function fieldsUrl(workspaceId: string, objectType: string): string {
    return `/workspaces/${workspaceId}/object-types/${objectType}/fields`;
  }

  function objectsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects`;
  }

  /** Defines a field (as `cookie`'s caller) and asserts the expected create
   * status (default 201). */
  async function defineField(
    cookie: string,
    workspaceId: string,
    objectType: string,
    body: {
      key: string;
      label: string;
      fieldType: string;
      config: unknown;
      defaultValue?: unknown;
      permissions: FieldPermissionsBody;
    },
  ): Promise<FieldDefinitionBody> {
    const response = await request(server)
      .post(fieldsUrl(workspaceId, objectType))
      .set('Cookie', cookie)
      .send(body);

    expect(response.status).toBe(201);
    return (response.body as FieldDefinitionEnvelope).fieldDefinition;
  }

  async function createObject(
    cookie: string,
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(objectsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ objectType, title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  function setFieldValues(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): request.Test {
    return request(server)
      .patch(`${objectsUrl(workspaceId)}/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });
  }

  function getObject(cookie: string, workspaceId: string, objectId: string): request.Test {
    return request(server)
      .get(`${objectsUrl(workspaceId)}/${objectId}`)
      .set('Cookie', cookie);
  }

  function listObjects(cookie: string, workspaceId: string): request.Test {
    return request(server).get(objectsUrl(workspaceId)).set('Cookie', cookie);
  }

  // -------------------------------------------------------------------------
  // AC #4 — defaults applied in the ObjectCreated flow, over HTTP
  // -------------------------------------------------------------------------

  it("AC #4: POST create applies an active field definition's defaultValue immediately, no extra call needed", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'priority',
      label: 'Priority',
      fieldType: 'select',
      config: { options: ['low', 'medium', 'high'] },
      defaultValue: 'medium',
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const object = await createObject(cookie, workspaceId, 'task', 'Ship the release');

    expect(object.fieldValues).toBeDefined();
    expect(object.fieldValues['priority']).toBe('medium');
  });

  it('AC #4: a field definition with no defaultValue contributes nothing; fieldValues is still present (empty object) when there is no default at all', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'note', {
      key: 'summary',
      label: 'Summary',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const object = await createObject(cookie, workspaceId, 'note', 'No default here');

    expect(object.fieldValues).toBeDefined();
    expect(object.fieldValues['summary']).toBeUndefined();
  });

  it('AC #4: defaults survive a subsequent GET (replay-durable, not just a create-response artifact)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'status',
      label: 'Status',
      fieldType: 'select',
      config: { options: ['todo', 'doing', 'done'] },
      defaultValue: 'todo',
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Default status task');

    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['status']).toBe('todo');
  });

  // -------------------------------------------------------------------------
  // AC #3 — PATCH .../objects/:objectId/fields: edit permission, 403/404/400,
  // batch atomicity
  // -------------------------------------------------------------------------

  it('AC #3: PATCH .../fields sets a value the caller has "edit" on -> 200, read-your-writes on a follow-up GET', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'notes',
      label: 'Notes',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Editable notes task');

    const patchResponse = await setFieldValues(cookie, workspaceId, created.id, {
      notes: 'first draft',
    });

    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as ObjectEnvelope).object.fieldValues['notes']).toBe('first draft');

    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['notes']).toBe('first draft');
  });

  it('AC #3 (central assertion): a guest with only "view" (not "edit") on a field cannot write it -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, 'task', {
      key: 'ownerOnlyField',
      label: 'Owner Only',
      fieldType: 'text',
      config: {},
      permissions: VIEW_FOR_GUEST_PERMISSIONS,
    });

    const created = await createObject(ownerCookie, workspaceId, 'task', 'Guest cannot edit this');

    const guestPatchResponse = await setFieldValues(guestCookie, workspaceId, created.id, {
      ownerOnlyField: 'guest tried to write this',
    });

    expect(guestPatchResponse.status).toBe(403);

    // The value must remain untouched by the rejected attempt.
    const getResponse = await getObject(ownerCookie, workspaceId, created.id);
    expect(
      (getResponse.body as ObjectEnvelope).object.fieldValues['ownerOnlyField'],
    ).toBeUndefined();
  });

  it('AC #3 (security regression): a guest with "hidden" on a field gets 404, not 403, when trying to write it — "hidden" must not be a distinguishable existence oracle from a truly nonexistent key', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, 'task', {
      key: 'hiddenField',
      label: 'Hidden Field',
      fieldType: 'text',
      config: {},
      permissions: HIDDEN_FOR_GUEST_PERMISSIONS,
    });

    const created = await createObject(
      ownerCookie,
      workspaceId,
      'task',
      'Guest cannot see or edit this',
    );

    const guestPatchResponse = await setFieldValues(guestCookie, workspaceId, created.id, {
      hiddenField: 'guest tried to write this',
    });

    // A "view"-only field correctly gets 403 (its existence is already known
    // to the caller via GET) — but a "hidden" field must be indistinguishable
    // from a field that was never defined at all, so this is 404, matching
    // the "no matching active field definition" case below exactly.
    expect(guestPatchResponse.status).toBe(404);
  });

  it('AC #3: PATCH .../fields for a fieldKey with no matching active field definition -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const created = await createObject(cookie, workspaceId, 'task', 'No such field defined');

    const response = await setFieldValues(cookie, workspaceId, created.id, {
      neverDefinedField: 'whatever',
    });

    expect(response.status).toBe(404);
  });

  it("AC #3: PATCH .../fields with a value invalid for the field's type/config -> 400 (select value not in options)", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'stage',
      label: 'Stage',
      fieldType: 'select',
      config: { options: ['todo', 'doing', 'done'] },
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Invalid select value');

    const response = await setFieldValues(cookie, workspaceId, created.id, {
      stage: 'not-a-real-option',
    });

    expect(response.status).toBe(400);
  });

  it("AC #3: PATCH .../fields with a value invalid for the field's type/config -> 400 (number given a string)", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'estimateHours',
      label: 'Estimate (hours)',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Invalid number value');

    const response = await setFieldValues(cookie, workspaceId, created.id, {
      estimateHours: 'not-a-number',
    });

    expect(response.status).toBe(400);
  });

  it('AC #3 (atomicity): a batch with one valid + one invalid value fails entirely (400), and the valid one is NOT partially applied', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'title2',
      label: 'Secondary Title',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    await defineField(cookie, workspaceId, 'task', {
      key: 'score',
      label: 'Score',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Atomic batch test');

    // Establish a known-good baseline for `title2` via its own successful,
    // isolated PATCH first.
    const baselineResponse = await setFieldValues(cookie, workspaceId, created.id, {
      title2: 'original value',
    });
    expect(baselineResponse.status).toBe(200);

    // Now a batch where `title2` WOULD be a valid change on its own, but
    // `score` is invalid (a string, not a number) — the whole request must
    // fail, and `title2` must NOT change to 'updated value'.
    const batchResponse = await setFieldValues(cookie, workspaceId, created.id, {
      title2: 'updated value',
      score: 'not-a-number',
    });

    expect(batchResponse.status).toBe(400);

    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['title2']).toBe(
      'original value',
    );
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['score']).toBeUndefined();
  });

  it('AC #3 (batch success): setting two field keys the caller can edit in one request applies both atomically', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'fieldA',
      label: 'Field A',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    await defineField(cookie, workspaceId, 'task', {
      key: 'fieldB',
      label: 'Field B',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Batch success test');

    const response = await setFieldValues(cookie, workspaceId, created.id, {
      fieldA: 'value a',
      fieldB: 'value b',
    });

    expect(response.status).toBe(200);
    const object = (response.body as ObjectEnvelope).object;
    expect(object.fieldValues['fieldA']).toBe('value a');
    expect(object.fieldValues['fieldB']).toBe('value b');
  });

  // -------------------------------------------------------------------------
  // AC #3 — hidden field filtering on GET (single) and GET (list)
  // -------------------------------------------------------------------------

  it('AC #3 (central assertion): a "hidden" field is fully absent from a guest\'s GET .../objects/:id response', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, 'task', {
      key: 'secretNote',
      label: 'Secret Note',
      fieldType: 'text',
      config: {},
      permissions: HIDDEN_FOR_GUEST_PERMISSIONS,
    });

    await defineField(ownerCookie, workspaceId, 'task', {
      key: 'visibleToGuest',
      label: 'Visible To Guest',
      fieldType: 'text',
      config: {},
      permissions: VIEW_FOR_GUEST_PERMISSIONS,
    });

    const created = await createObject(ownerCookie, workspaceId, 'task', 'Hidden filtering task');

    const ownerSetSecret = await setFieldValues(ownerCookie, workspaceId, created.id, {
      secretNote: 'owner-only content',
    });
    expect(ownerSetSecret.status).toBe(200);

    const ownerSetVisible = await setFieldValues(ownerCookie, workspaceId, created.id, {
      visibleToGuest: 'guest can read this',
    });
    expect(ownerSetVisible.status).toBe(200);

    const guestGetResponse = await getObject(guestCookie, workspaceId, created.id);
    expect(guestGetResponse.status).toBe(200);

    const guestFieldValues = (guestGetResponse.body as ObjectEnvelope).object.fieldValues;
    expect(Object.prototype.hasOwnProperty.call(guestFieldValues, 'secretNote')).toBe(false);
    expect(guestFieldValues['visibleToGuest']).toBe('guest can read this');

    // The owner (who has 'edit' on both) still sees everything.
    const ownerGetResponse = await getObject(ownerCookie, workspaceId, created.id);
    const ownerFieldValues = (ownerGetResponse.body as ObjectEnvelope).object.fieldValues;
    expect(ownerFieldValues['secretNote']).toBe('owner-only content');
    expect(ownerFieldValues['visibleToGuest']).toBe('guest can read this');
  });

  it('AC #3 (central assertion, list route): a "hidden" field is fully absent from a guest\'s GET .../objects (collection) response too', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, 'task', {
      key: 'secretNoteList',
      label: 'Secret Note (list)',
      fieldType: 'text',
      config: {},
      permissions: HIDDEN_FOR_GUEST_PERMISSIONS,
    });

    const created = await createObject(
      ownerCookie,
      workspaceId,
      'task',
      'Hidden filtering task (list)',
    );

    const ownerSet = await setFieldValues(ownerCookie, workspaceId, created.id, {
      secretNoteList: 'owner-only content',
    });
    expect(ownerSet.status).toBe(200);

    const guestListResponse = await listObjects(guestCookie, workspaceId);
    expect(guestListResponse.status).toBe(200);

    const guestListed = (guestListResponse.body as ObjectListEnvelope).objects.find(
      (o) => o.id === created.id,
    );
    expect(guestListed).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(guestListed?.fieldValues ?? {}, 'secretNoteList'),
    ).toBe(false);

    const ownerListResponse = await listObjects(ownerCookie, workspaceId);
    const ownerListed = (ownerListResponse.body as ObjectListEnvelope).objects.find(
      (o) => o.id === created.id,
    );
    expect(ownerListed?.fieldValues['secretNoteList']).toBe('owner-only content');
  });

  // -------------------------------------------------------------------------
  // AC #5 — updating a field's definition after a value was set does not
  // corrupt the already-stored value
  // -------------------------------------------------------------------------

  it("AC #5: removing a select option from a field definition's config does not corrupt an already-stored value using that option", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const fieldDefinition = await defineField(cookie, workspaceId, 'task', {
      key: 'workflowStage',
      label: 'Workflow Stage',
      fieldType: 'select',
      config: { options: ['todo', 'doing', 'done'] },
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Backward-compat task');

    const setResponse = await setFieldValues(cookie, workspaceId, created.id, {
      workflowStage: 'doing',
    });
    expect(setResponse.status).toBe(200);
    expect((setResponse.body as ObjectEnvelope).object.fieldValues['workflowStage']).toBe('doing');

    // Update the field DEFINITION's config so 'doing' is no longer a valid
    // option — the previously-recorded value must survive this unchanged.
    const updateDefinitionResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinition.id}`)
      .set('Cookie', cookie)
      .send({ config: { options: ['todo', 'in-progress', 'done'] } });

    expect(updateDefinitionResponse.status).toBe(200);

    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['workflowStage']).toBe('doing');
  });
});
