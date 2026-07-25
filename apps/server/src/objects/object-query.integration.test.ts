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
 * F1-T6 PR-C (RED step) — server-side integration of the new query/filter/
 * sort/group endpoint for Lumina Objects: `POST
 * /workspaces/:workspaceId/objects/query`.
 *
 * ============================================================================
 * RED STATE (expected, today): NOTHING under test in this file exists yet.
 *
 *  - `POST /workspaces/:workspaceId/objects/query` is a BRAND NEW route --
 *    `ObjectsController` has no handler for it today, so every request below
 *    is expected to 404 via Nest's own default "Cannot POST ..." handler (no
 *    matching route at all), NOT via `AppErrorFilter` mapping an `AppError`.
 *    NOTE: because of this, any assertion below that itself expects a `404`
 *    status (the hidden-field / unknown-field-key cases) will, at this
 *    exact pre-implementation moment, coincidentally get a `404` too --  but
 *    for the WRONG reason (missing route, not `NotFoundError`). This file
 *    additionally asserts `error.code === 'NOT_FOUND'` /
 *    `error.code === 'VALIDATION_ERROR'` on every such case specifically so
 *    that coincidence is caught: Nest's own default 404 handler's body shape
 *    does NOT contain `{ error: { code: 'NOT_FOUND', ... } }`, so those
 *    `.error.code` assertions still fail red today, for the right reason.
 *    Same precedent as `object-field-values.integration.test.ts`'s own PATCH
 *    route header comment.
 *  - `ObjectsService.query` does not exist -- once the route exists, calling
 *    it would throw `TypeError: this.objectsService.query is not a
 *    function`.
 *  - `querySpecSchema` (from `@luminaos/shared`, F1-T6 PR-A) and
 *    `getValidOperatorsForField` / `assertValidFilterCondition` /
 *    `assertGroupableField` / `assertSortableField` (from
 *    `@luminaos/core-objects`, F1-T6 PR-B) already resolve and are already
 *    green as of this PR -- this file does not re-test them, it pins how the
 *    SERVER wires them together.
 *
 * `implementer` must build a `query-builder.ts`/`ObjectsService.query`/
 * `ObjectsController` route matching the contract pinned below; every test
 * in this file is expected to fail (red) until then.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISIONS THIS FILE PINS (no other source of truth exists for these
 * yet -- `implementer` must match them precisely):
 *
 * - Route: `POST /workspaces/:workspaceId/objects/query`, same guard stack
 *   (`SessionAuthGuard`, `WorkspaceMembershipGuard`) as every other route on
 *   `ObjectsController`, body validated via `ZodValidationPipe(querySpecSchema)`.
 *   Read-only (no `actor`, no event writes) -- only `requireRole(req)`.
 * - Implicit scope: only `lifecycle !== 'deleted'` objects are ever returned
 *   (archived objects ARE included) -- this is NOT caller-controllable.
 * - Flat mode (no `group`): `200 { objects: [...], nextCursor?: string }`.
 *   `nextCursor` present only when the page was cut short by `limit`.
 * - Group mode (`group` present): `200 { groups: [{ groupValue, count,
 *   items }] }`. NO pagination in group mode -- `limit`/`cursor` in the
 *   request body are silently IGNORED when `group` is set (not an error).
 *   An object whose group field has NO value set at all is EXCLUDED from
 *   every group (does not create a null/empty-value group, does not inflate
 *   any count).
 * - Validation precedence (exact order): (1) unknown `objectType` -> 400;
 *   (2) any referenced field key (filters[].field / sort[].field / group)
 *   that is not a fixed column and has no active, VISIBLE-to-this-caller
 *   field definition -> 404 (a hidden field is indistinguishable from an
 *   undefined one, exactly mirroring `ObjectsService.setFieldValues`'s own
 *   precedent -- 404, never 403, for "hidden"); (3) invalid operator for a
 *   real custom field's type (`assertValidFilterCondition`) -> 400;
 *   (4) unsortable field type (`assertSortableField`) -> 400; (5) ungroupable
 *   field type (`assertGroupableField`) -> 400; (6) operator-driven `value`
 *   shape rules (see below) -> 400.
 * - Fixed columns (`title`, `createdAt`, `updatedAt`) are always
 *   filterable/sortable for ANY caller (no permission concept applies).
 *   `title`: equals/notEquals/contains/notContains/isEmpty/isNotEmpty.
 *   `createdAt`/`updatedAt`: equals/before/after/between/isEmpty/isNotEmpty
 *   (isEmpty/isNotEmpty are accepted operators for these even though they're
 *   always-false/always-true in practice -- not specially rejected).
 * - Operator-driven value shape (independent of field type): `between`/
 *   `in`/`notIn` REQUIRE `value` to be an array (`between` exactly 2
 *   elements); `isEmpty`/`isNotEmpty` require `value` to be ABSENT; every
 *   other operator requires `value` present and NOT an array. Violating any
 *   of these -> 400, regardless of whether the field/operator pairing
 *   itself would otherwise be valid.
 * - `text` `contains`/`notContains` in this file's fixtures is CASE-SENSITIVE
 *   substring matching (one deliberate, documented choice among valid
 *   options -- see the `text` describe block below).
 * - `number`/date-typed `between` is INCLUSIVE on both ends (deliberate,
 *   documented choice -- see the `number` describe block below).
 * - Cursor is treated as an OPAQUE, implementation-defined token by this
 *   file -- no test anywhere hardcodes an expected cursor STRING value; a
 *   cursor is only ever captured from one response and passed back verbatim
 *   into a follow-up request. See `object-query-pagination.integration.test.ts`
 *   for the full pagination walk + malformed-cursor coverage.
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

interface QueryFlatEnvelope {
  objects: ObjectBody[];
  nextCursor?: string;
}

interface QueryGroupEntry {
  groupValue: string;
  count: number;
  items: ObjectBody[];
}

interface QueryGroupEnvelope {
  groups: QueryGroupEntry[];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface ApiErrorEnvelope {
  error: { code: string; message: string };
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

/** Fully hidden from guests only -- used for the hidden-filtering /
 * hidden-field-query-404 scenarios. */
const HIDDEN_FOR_GUEST_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'hidden',
};

/** The only permission shape a formula field may legally have -- no role
 * ever gets `'edit'` (mirrors `object-formula-recompute.integration.test.ts`). */
const FORMULA_VIEW_ONLY_PERMISSIONS: FieldPermissionsBody = {
  owner: 'view',
  admin: 'view',
  member: 'view',
  guest: 'view',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `object-query-test-user-${String(emailCounter)}@example.com`;
}

describe('Lumina Object query/filter/sort/group endpoint (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Query Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

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

  function listObjects(cookie: string, workspaceId: string): request.Test {
    return request(server).get(objectsUrl(workspaceId)).set('Cookie', cookie);
  }

  function queryObjects(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(server)
      .post(`${objectsUrl(workspaceId)}/query`)
      .set('Cookie', cookie)
      .send(body);
  }

  function expectValidationError(response: request.Response): void {
    expect(response.status).toBe(400);
    expect((response.body as ApiErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  }

  function expectNotFoundError(response: request.Response): void {
    expect(response.status).toBe(404);
    expect((response.body as ApiErrorEnvelope).error.code).toBe('NOT_FOUND');
  }

  /** Defines the standard `task` field set this file's field-type-coverage,
   * sorting, and grouping describes share: `notes` (text), `score`
   * (number), `dueDate` (date), `status` (select), `urgent` (checkbox),
   * `doubledScore` (formula, `{score} * 2`, only ever computed once `score`
   * is written -- never has a value on a freshly-created object). */
  async function defineStandardTaskFields(cookie: string, workspaceId: string): Promise<void> {
    await defineField(cookie, workspaceId, 'task', {
      key: 'notes',
      label: 'Notes',
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

    await defineField(cookie, workspaceId, 'task', {
      key: 'dueDate',
      label: 'Due Date',
      fieldType: 'date',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    await defineField(cookie, workspaceId, 'task', {
      key: 'status',
      label: 'Status',
      fieldType: 'select',
      config: { options: ['todo', 'doing', 'done'] },
      permissions: EDIT_ALL_PERMISSIONS,
    });

    await defineField(cookie, workspaceId, 'task', {
      key: 'urgent',
      label: 'Urgent',
      fieldType: 'checkbox',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    await defineField(cookie, workspaceId, 'task', {
      key: 'doubledScore',
      label: 'Doubled Score',
      fieldType: 'formula',
      config: { expression: '{score} * 2' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
  }

  // ===========================================================================
  // Validation precedence
  // ===========================================================================

  describe('validation precedence', () => {
    it('unknown objectType -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'not-a-real-object-type',
        filters: [],
      });

      expectValidationError(response);
    });

    it('filter referencing a field key with no matching active field definition at all -> 404 NOT_FOUND', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'neverDefinedField', operator: 'equals', value: 'x' }],
      });

      expectNotFoundError(response);
    });

    it('sort referencing a field key with no matching active field definition -> 404 NOT_FOUND', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'neverDefinedField', direction: 'asc' }],
      });

      expectNotFoundError(response);
    });

    it('group referencing a field key with no matching active field definition -> 404 NOT_FOUND', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        group: 'neverDefinedField',
      });

      expectNotFoundError(response);
    });

    it("filter referencing a field HIDDEN from the caller's role -> 404 NOT_FOUND, not 403 (must be indistinguishable from undefined)", async () => {
      const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');

      await defineField(ownerCookie, workspaceId, 'task', {
        key: 'secretScore',
        label: 'Secret Score',
        fieldType: 'number',
        config: {},
        permissions: HIDDEN_FOR_GUEST_PERMISSIONS,
      });

      const response = await queryObjects(guestCookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'secretScore', operator: 'equals', value: 5 }],
      });

      expectNotFoundError(response);
    });

    it('checkbox field with operator "contains" -> 400 VALIDATION_ERROR (the spec\'s own called-out invalid-operator example)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'urgent', operator: 'contains', value: 'x' }],
      });

      expectValidationError(response);
    });

    it('sorting by a multiSelect field -> 400 VALIDATION_ERROR (not sortable)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'tags',
        label: 'Tags',
        fieldType: 'multiSelect',
        config: { options: ['a', 'b', 'c'] },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'tags', direction: 'asc' }],
      });

      expectValidationError(response);
    });

    it('sorting by a formula field -> 400 VALIDATION_ERROR (not sortable)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'doubledScore', direction: 'asc' }],
      });

      expectValidationError(response);
    });

    it('grouping by a non-select field (text) -> 400 VALIDATION_ERROR (not groupable)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        group: 'notes',
      });

      expectValidationError(response);
    });

    it('fixed column "title" with an operator outside its table (e.g. "gt") -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'title', operator: 'gt', value: 'x' }],
      });

      expectValidationError(response);
    });

    it('fixed column "createdAt" with an operator outside its table (e.g. "contains") -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'createdAt', operator: 'contains', value: 'x' }],
      });

      expectValidationError(response);
    });

    // --- operator-driven `value` shape rules -------------------------------

    it('"between" with a non-array value -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'between', value: 5 }],
      });

      expectValidationError(response);
    });

    it('"between" with an array of length != 2 -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'between', value: [1, 2, 3] }],
      });

      expectValidationError(response);
    });

    it('"in" with a non-array value -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'in', value: 'todo' }],
      });

      expectValidationError(response);
    });

    it('"notIn" with a non-array value -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'notIn', value: 'todo' }],
      });

      expectValidationError(response);
    });

    it('"isEmpty" with a value present -> 400 VALIDATION_ERROR (must be absent)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'notes', operator: 'isEmpty', value: 'unexpected' }],
      });

      expectValidationError(response);
    });

    it('"isNotEmpty" with a value present -> 400 VALIDATION_ERROR (must be absent)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'notes', operator: 'isNotEmpty', value: 'unexpected' }],
      });

      expectValidationError(response);
    });

    it('"equals" with an array value -> 400 VALIDATION_ERROR (must not be an array)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'equals', value: [1, 2] }],
      });

      expectValidationError(response);
    });

    it('"equals" with value absent -> 400 VALIDATION_ERROR (must be present)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'equals' }],
      });

      expectValidationError(response);
    });

    // --- security review follow-up: field-type-aware value validation -----

    it('"equals" on a number field with a non-numeric string value -> 400 VALIDATION_ERROR (not a raw 500 from an unchecked ::numeric cast)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'equals', value: 'not-a-number' }],
      });

      expectValidationError(response);
    });

    it('"before" on a date field with an unparseable date string -> 400 VALIDATION_ERROR (not a raw 500 from an unchecked ::timestamptz cast)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'dueDate', operator: 'before', value: 'not-a-date' }],
      });

      expectValidationError(response);
    });

    it('"equals" on a checkbox field with a non-boolean value -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'urgent', operator: 'equals', value: 'true' }],
      });

      expectValidationError(response);
    });

    it('"in" on a select field with a non-string array element -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'in', value: ['todo', 42] }],
      });

      expectValidationError(response);
    });

    it('"in" array value with more than 100 entries -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [
          { field: 'status', operator: 'in', value: Array.from({ length: 101 }, () => 'todo') },
        ],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // Field-type filtering behavior (6 representative types)
  // ===========================================================================

  describe('filtering behavior: text field ("notes")', () => {
    it('"contains" (case-sensitive substring, this file\'s deliberate choice) matches only rows containing the substring', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const alpha = await createObject(cookie, workspaceId, 'task', 'Alpha task');
      await setFieldValues(cookie, workspaceId, alpha.id, { notes: 'Alpha apple pie' });

      const banana = await createObject(cookie, workspaceId, 'task', 'Banana task');
      await setFieldValues(cookie, workspaceId, banana.id, { notes: 'Banana bread' });

      const cherry = await createObject(cookie, workspaceId, 'task', 'Cherry task');
      await setFieldValues(cookie, workspaceId, cherry.id, { notes: 'Cherry apple tart' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'notes', operator: 'contains', value: 'apple' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      expect(ids).toEqual([alpha.id, cherry.id].sort());
    });

    it('"equals" matches only an exact match', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const exact = await createObject(cookie, workspaceId, 'task', 'Exact task');
      await setFieldValues(cookie, workspaceId, exact.id, { notes: 'Banana bread' });

      const other = await createObject(cookie, workspaceId, 'task', 'Other task');
      await setFieldValues(cookie, workspaceId, other.id, { notes: 'Banana bread loaf' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'notes', operator: 'equals', value: 'Banana bread' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id);
      expect(ids).toEqual([exact.id]);
    });

    it('"contains" with a literal backslash-underscore in the value matches only the literal text, never treating the underscore as a live ILIKE wildcard (security review follow-up)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      // The literal, intended match: contains the exact substring `a\_b`.
      const literalMatch = await createObject(cookie, workspaceId, 'task', 'Literal match');
      await setFieldValues(cookie, workspaceId, literalMatch.id, { notes: 'prefix a\\_b suffix' });

      // If the trailing `_` in the search value were ever (incorrectly)
      // treated as a live single-char wildcard, this row -- which only
      // matches if `_` matches ANY character -- would also match. It must
      // NOT be returned.
      const wildcardDecoy = await createObject(cookie, workspaceId, 'task', 'Wildcard decoy');
      await setFieldValues(cookie, workspaceId, wildcardDecoy.id, { notes: 'prefix a\\Xb suffix' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'notes', operator: 'contains', value: 'a\\_b' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id);
      expect(ids).toEqual([literalMatch.id]);
    });
  });

  describe('filtering behavior: number field ("score")', () => {
    async function createScoredObjects(
      cookie: string,
      workspaceId: string,
    ): Promise<Record<number, ObjectBody>> {
      const byScore: Record<number, ObjectBody> = {};

      for (const score of [5, 10, 20, 25]) {
        const object = await createObject(cookie, workspaceId, 'task', `Score ${String(score)}`);
        await setFieldValues(cookie, workspaceId, object.id, { score });
        byScore[score] = object;
      }

      return byScore;
    }

    it('"gt"/"lt" bound correctly', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);
      const byScore = await createScoredObjects(cookie, workspaceId);

      const gtResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'gt', value: 15 }],
      });
      expect(gtResponse.status).toBe(200);
      expect((gtResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [byScore[20]?.id, byScore[25]?.id].sort(),
      );

      const ltResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'lt', value: 15 }],
      });
      expect(ltResponse.status).toBe(200);
      expect((ltResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [byScore[5]?.id, byScore[10]?.id].sort(),
      );
    });

    it('"between" is INCLUSIVE on both ends (this file\'s deliberate choice)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);
      const byScore = await createScoredObjects(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'score', operator: 'between', value: [10, 20] }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [byScore[10]?.id, byScore[20]?.id].sort(),
      );
    });
  });

  describe('filtering behavior: date field ("dueDate")', () => {
    it('"before"/"after" bound correctly relative to a pivot date', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const early = await createObject(cookie, workspaceId, 'task', 'Early task');
      await setFieldValues(cookie, workspaceId, early.id, { dueDate: '2026-01-01' });

      const mid = await createObject(cookie, workspaceId, 'task', 'Mid task');
      await setFieldValues(cookie, workspaceId, mid.id, { dueDate: '2026-02-15' });

      const late = await createObject(cookie, workspaceId, 'task', 'Late task');
      await setFieldValues(cookie, workspaceId, late.id, { dueDate: '2026-05-01' });

      const beforeResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'dueDate', operator: 'before', value: '2026-03-01' }],
      });
      expect(beforeResponse.status).toBe(200);
      expect((beforeResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [early.id, mid.id].sort(),
      );

      const afterResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'dueDate', operator: 'after', value: '2026-03-01' }],
      });
      expect(afterResponse.status).toBe(200);
      expect((afterResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([late.id]);
    });
  });

  describe('filtering behavior: select field ("status")', () => {
    it('"in" matches any of the listed options; "equals" matches exactly one', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const todoObject = await createObject(cookie, workspaceId, 'task', 'Todo task');
      await setFieldValues(cookie, workspaceId, todoObject.id, { status: 'todo' });

      const doingObject = await createObject(cookie, workspaceId, 'task', 'Doing task');
      await setFieldValues(cookie, workspaceId, doingObject.id, { status: 'doing' });

      const doneObject = await createObject(cookie, workspaceId, 'task', 'Done task');
      await setFieldValues(cookie, workspaceId, doneObject.id, { status: 'done' });

      const inResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'in', value: ['todo', 'doing'] }],
      });
      expect(inResponse.status).toBe(200);
      expect((inResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [todoObject.id, doingObject.id].sort(),
      );

      const equalsResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'equals', value: 'done' }],
      });
      expect(equalsResponse.status).toBe(200);
      expect((equalsResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        doneObject.id,
      ]);
    });
  });

  describe('filtering behavior: checkbox field ("urgent")', () => {
    it('"equals: true" vs "equals: false" partition correctly', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const urgentOne = await createObject(cookie, workspaceId, 'task', 'Urgent one');
      await setFieldValues(cookie, workspaceId, urgentOne.id, { urgent: true });

      const notUrgent = await createObject(cookie, workspaceId, 'task', 'Not urgent');
      await setFieldValues(cookie, workspaceId, notUrgent.id, { urgent: false });

      const urgentTwo = await createObject(cookie, workspaceId, 'task', 'Urgent two');
      await setFieldValues(cookie, workspaceId, urgentTwo.id, { urgent: true });

      const trueResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'urgent', operator: 'equals', value: true }],
      });
      expect(trueResponse.status).toBe(200);
      expect((trueResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [urgentOne.id, urgentTwo.id].sort(),
      );

      const falseResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'urgent', operator: 'equals', value: false }],
      });
      expect(falseResponse.status).toBe(200);
      expect((falseResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        notUrgent.id,
      ]);
    });

    it('"contains" on a checkbox field -> 400 VALIDATION_ERROR', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'urgent', operator: 'contains', value: 'x' }],
      });

      expectValidationError(response);
    });
  });

  describe('filtering behavior: formula field ("doubledScore" = {score} * 2)', () => {
    it('"equals"/"isEmpty"/"isNotEmpty" work as expected', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const scoredFive = await createObject(cookie, workspaceId, 'task', 'Scored five');
      await setFieldValues(cookie, workspaceId, scoredFive.id, { score: 5 });

      const scoredSeven = await createObject(cookie, workspaceId, 'task', 'Scored seven');
      await setFieldValues(cookie, workspaceId, scoredSeven.id, { score: 7 });

      // `score` never set -> `doubledScore` is never computed -> genuinely
      // absent (not `null`) from `fieldValues`, i.e. a natural "empty" case.
      const neverScored = await createObject(cookie, workspaceId, 'task', 'Never scored');

      const equalsResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'doubledScore', operator: 'equals', value: 10 }],
      });
      expect(equalsResponse.status).toBe(200);
      expect((equalsResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        scoredFive.id,
      ]);

      const isEmptyResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'doubledScore', operator: 'isEmpty' }],
      });
      expect(isEmptyResponse.status).toBe(200);
      expect((isEmptyResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        neverScored.id,
      ]);

      const isNotEmptyResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'doubledScore', operator: 'isNotEmpty' }],
      });
      expect(isNotEmptyResponse.status).toBe(200);
      expect(
        (isNotEmptyResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort(),
      ).toEqual([scoredFive.id, scoredSeven.id].sort());
    });

    it('"gt" on a formula field -> 400 VALIDATION_ERROR (formula\'s operator set is generic-only)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'doubledScore', operator: 'gt', value: 10 }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // SQL injection sanity check (lightweight -- full coverage deferred)
  // ===========================================================================

  describe('SQL injection sanity check', () => {
    it('a filter value containing a DROP TABLE payload returns a normal 200 with no matches, and does NOT actually drop objects_view', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const survivor = await createObject(cookie, workspaceId, 'task', 'Survivor task');

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [
          { field: 'title', operator: 'contains', value: "'; DROP TABLE objects_view; --" },
        ],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects).toEqual([]);

      // Follow-up plain list() proves objects_view still exists and still
      // contains the previously-created object -- the table was NOT dropped.
      const listResponse = await listObjects(cookie, workspaceId);
      expect(listResponse.status).toBe(200);
      const survived = (listResponse.body as ObjectListEnvelope).objects.find(
        (o) => o.id === survivor.id,
      );
      expect(survived).toBeDefined();
    });
  });

  // ===========================================================================
  // Sorting
  // ===========================================================================

  describe('sorting', () => {
    it('sort by "title" ascending and descending', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const charlie = await createObject(cookie, workspaceId, 'task', 'Charlie');
      const alpha = await createObject(cookie, workspaceId, 'task', 'Alpha');
      const bravo = await createObject(cookie, workspaceId, 'task', 'Bravo');

      const ascResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'title', direction: 'asc' }],
      });
      expect(ascResponse.status).toBe(200);
      expect((ascResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        alpha.id,
        bravo.id,
        charlie.id,
      ]);

      const descResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'title', direction: 'desc' }],
      });
      expect(descResponse.status).toBe(200);
      expect((descResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        charlie.id,
        bravo.id,
        alpha.id,
      ]);
    });

    it('sort by "createdAt" (creation order)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const first = await createObject(cookie, workspaceId, 'task', 'First');
      const second = await createObject(cookie, workspaceId, 'task', 'Second');
      const third = await createObject(cookie, workspaceId, 'task', 'Third');

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'createdAt', direction: 'asc' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
    });

    it('sort by a custom "number" field', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const low = await createObject(cookie, workspaceId, 'task', 'Low score');
      await setFieldValues(cookie, workspaceId, low.id, { score: 1 });

      const high = await createObject(cookie, workspaceId, 'task', 'High score');
      await setFieldValues(cookie, workspaceId, high.id, { score: 99 });

      const mid = await createObject(cookie, workspaceId, 'task', 'Mid score');
      await setFieldValues(cookie, workspaceId, mid.id, { score: 50 });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'score', direction: 'asc' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        low.id,
        mid.id,
        high.id,
      ]);
    });

    it('sort by a custom "date" field', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const late = await createObject(cookie, workspaceId, 'task', 'Late due');
      await setFieldValues(cookie, workspaceId, late.id, { dueDate: '2026-09-01' });

      const early = await createObject(cookie, workspaceId, 'task', 'Early due');
      await setFieldValues(cookie, workspaceId, early.id, { dueDate: '2026-01-15' });

      const mid = await createObject(cookie, workspaceId, 'task', 'Mid due');
      await setFieldValues(cookie, workspaceId, mid.id, { dueDate: '2026-05-10' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        sort: [{ field: 'dueDate', direction: 'asc' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        early.id,
        mid.id,
        late.id,
      ]);
    });
  });

  // ===========================================================================
  // Grouping
  // ===========================================================================

  describe('grouping', () => {
    it('groups by a select field: correct count/items per group, and an object with no value set is excluded from every group', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const todoOne = await createObject(cookie, workspaceId, 'task', 'Todo one');
      await setFieldValues(cookie, workspaceId, todoOne.id, { status: 'todo' });
      const todoTwo = await createObject(cookie, workspaceId, 'task', 'Todo two');
      await setFieldValues(cookie, workspaceId, todoTwo.id, { status: 'todo' });

      const doingOne = await createObject(cookie, workspaceId, 'task', 'Doing one');
      await setFieldValues(cookie, workspaceId, doingOne.id, { status: 'doing' });
      const doingTwo = await createObject(cookie, workspaceId, 'task', 'Doing two');
      await setFieldValues(cookie, workspaceId, doingTwo.id, { status: 'doing' });
      const doingThree = await createObject(cookie, workspaceId, 'task', 'Doing three');
      await setFieldValues(cookie, workspaceId, doingThree.id, { status: 'doing' });

      const doneOne = await createObject(cookie, workspaceId, 'task', 'Done one');
      await setFieldValues(cookie, workspaceId, doneOne.id, { status: 'done' });

      // Never has `status` set at all -- must not appear in any group.
      const neverSet = await createObject(cookie, workspaceId, 'task', 'Never set status');
      void neverSet;

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        group: 'status',
      });

      expect(response.status).toBe(200);
      const { groups } = response.body as QueryGroupEnvelope;
      expect(groups).toHaveLength(3);

      const byValue = new Map(groups.map((g) => [g.groupValue, g]));

      const todoGroup = byValue.get('todo');
      expect(todoGroup?.count).toBe(2);
      expect(todoGroup?.items.map((o) => o.id).sort()).toEqual([todoOne.id, todoTwo.id].sort());

      const doingGroup = byValue.get('doing');
      expect(doingGroup?.count).toBe(3);
      expect(doingGroup?.items.map((o) => o.id).sort()).toEqual(
        [doingOne.id, doingTwo.id, doingThree.id].sort(),
      );

      const doneGroup = byValue.get('done');
      expect(doneGroup?.count).toBe(1);
      expect(doneGroup?.items.map((o) => o.id)).toEqual([doneOne.id]);

      // The never-set object must not appear anywhere.
      for (const group of groups) {
        expect(group.items.map((o) => o.id)).not.toContain(neverSet.id);
      }
    });

    it('group composes with a non-empty filters array (filters narrow what ends up in each group)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const todoUrgent = await createObject(cookie, workspaceId, 'task', 'Todo urgent');
      await setFieldValues(cookie, workspaceId, todoUrgent.id, { status: 'todo', urgent: true });

      const todoNotUrgent = await createObject(cookie, workspaceId, 'task', 'Todo not urgent');
      await setFieldValues(cookie, workspaceId, todoNotUrgent.id, {
        status: 'todo',
        urgent: false,
      });

      const doingUrgent = await createObject(cookie, workspaceId, 'task', 'Doing urgent');
      await setFieldValues(cookie, workspaceId, doingUrgent.id, { status: 'doing', urgent: true });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'urgent', operator: 'equals', value: true }],
        group: 'status',
      });

      expect(response.status).toBe(200);
      const { groups } = response.body as QueryGroupEnvelope;
      const byValue = new Map(groups.map((g) => [g.groupValue, g]));

      expect(byValue.get('todo')?.count).toBe(1);
      expect(byValue.get('todo')?.items.map((o) => o.id)).toEqual([todoUrgent.id]);

      expect(byValue.get('doing')?.count).toBe(1);
      expect(byValue.get('doing')?.items.map((o) => o.id)).toEqual([doingUrgent.id]);

      // `todoNotUrgent` was filtered out entirely -- no group should contain it.
      for (const group of groups) {
        expect(group.items.map((o) => o.id)).not.toContain(todoNotUrgent.id);
      }
    });

    it('group mode IGNORES "limit"/"cursor" in the request body (no pagination in group mode)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineStandardTaskFields(cookie, workspaceId);

      const created: ObjectBody[] = [];
      for (let i = 0; i < 5; i += 1) {
        const object = await createObject(cookie, workspaceId, 'task', `Grouped ${String(i)}`);
        await setFieldValues(cookie, workspaceId, object.id, { status: 'todo' });
        created.push(object);
      }

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [],
        group: 'status',
        limit: 2,
      });

      expect(response.status).toBe(200);
      const { groups } = response.body as QueryGroupEnvelope;
      const todoGroup = groups.find((g) => g.groupValue === 'todo');

      // ALL 5 matching items are present, despite `limit: 2` in the request.
      expect(todoGroup?.count).toBe(5);
      expect(todoGroup?.items).toHaveLength(5);
      expect(todoGroup?.items.map((o) => o.id).sort()).toEqual(created.map((o) => o.id).sort());
    });
  });

  // ===========================================================================
  // Role-based hidden-field enforcement
  // ===========================================================================

  describe('role-based hidden-field enforcement', () => {
    it('a guest filtering by a field hidden from guests -> 404 NOT_FOUND', async () => {
      const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');

      await defineField(ownerCookie, workspaceId, 'task', {
        key: 'confidentialNotes',
        label: 'Confidential Notes',
        fieldType: 'text',
        config: {},
        permissions: HIDDEN_FOR_GUEST_PERMISSIONS,
      });

      const response = await queryObjects(guestCookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'confidentialNotes', operator: 'equals', value: 'x' }],
      });

      expectNotFoundError(response);
    });

    it("a guest's query results never contain a hidden field's key at all, while owner/admin/member queries DO", async () => {
      const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');
      const adminCookie = await addMemberWithRole(workspaceId, 'admin');
      const memberCookie = await addMemberWithRole(workspaceId, 'member');

      await defineField(ownerCookie, workspaceId, 'task', {
        key: 'confidentialNotes',
        label: 'Confidential Notes',
        fieldType: 'text',
        config: {},
        permissions: HIDDEN_FOR_GUEST_PERMISSIONS,
      });

      const created = await createObject(ownerCookie, workspaceId, 'task', 'Has a secret');
      await setFieldValues(ownerCookie, workspaceId, created.id, {
        confidentialNotes: 'owner-only content',
      });

      const guestResponse = await queryObjects(guestCookie, workspaceId, {
        objectType: 'task',
        filters: [],
      });
      expect(guestResponse.status).toBe(200);
      const guestObject = (guestResponse.body as QueryFlatEnvelope).objects.find(
        (o) => o.id === created.id,
      );
      expect(guestObject).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(guestObject?.fieldValues ?? {}, 'confidentialNotes'),
      ).toBe(false);

      for (const visibleCookie of [ownerCookie, adminCookie, memberCookie]) {
        const response = await queryObjects(visibleCookie, workspaceId, {
          objectType: 'task',
          filters: [],
        });
        expect(response.status).toBe(200);
        const object = (response.body as QueryFlatEnvelope).objects.find(
          (o) => o.id === created.id,
        );
        expect(object?.fieldValues['confidentialNotes']).toBe('owner-only content');
      }
    });
  });
});
