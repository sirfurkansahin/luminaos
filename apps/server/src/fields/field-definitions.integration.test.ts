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
 * F1-T2 PR-B: real, end-to-end integration test for the field-DEFINITION
 * CRUD HTTP surface (`FieldDefinitionsService`/`FieldsController`), mirroring
 * `../objects/objects.integration.test.ts`'s pattern exactly (same
 * Testcontainers Postgres 16 + Redis 7 pair, same dynamic
 * `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL` are set,
 * same `toCookieHeader` helper copied verbatim). Nothing here is mocked.
 *
 * This PR is field-DEFINITION CRUD only (define/update/archive/list) — field
 * VALUES (`setFieldValue`/`setFieldValues`, `objects_view.field_values`,
 * role-filtered `GET .../objects` reads) are PR-C's job and are NOT tested
 * here.
 *
 * ============================================================================
 * RED STATE (expected, today): `AppModule` (`../app.module.ts`) does not yet
 * import a `FieldsModule` — there is no `fields.module.ts`,
 * `fields.controller.ts`, `field-definitions.service.ts`,
 * `field-definitions.projection.ts`, or `field_definitions` DB table/schema
 * yet (PR-A only built the pure domain in
 * `packages/core-objects/src/fields/`; none of it is wired into the server).
 * Every request below to `/workspaces/:workspaceId/object-types/:objectType/
 * fields...` is therefore expected to 404 via Nest's own default
 * "Cannot POST/GET/PATCH ..." handler (there is no matching route at all),
 * NOT via `AppErrorFilter` mapping an `AppError` — assertions below will fail
 * with e.g. "expected 404 to be 201" and the body will be Nest's default
 * `{"message":"Cannot POST /workspaces/.../fields","error":"Not
 * Found","statusCode":404}` shape rather than `{ fieldDefinition: {...} }`.
 * That is the correct red: it means the ROUTE doesn't exist yet, not that
 * test logic itself is wrong. `implementer` must add the `field_definitions`
 * migration + `FieldsModule` (imported by `AppModule`) to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/object-types/:objectType/fields')`,
 * guarded by `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class
 * level (identical guard stack to `ObjectsController`).
 *
 *   POST   /workspaces/:workspaceId/object-types/:objectType/fields
 *          -> 201 { fieldDefinition }
 *          body: { key, label, fieldType, config, defaultValue?, permissions }
 *          ADMIN-GATED: requires `hasAtLeastRole(req.membership.role, 'admin')`
 *          (member/guest -> 403, `ForbiddenError`). Design decision, per the
 *          plan: "admin ve üzeri şema yönetebilir" — checked INLINE in the
 *          controller (reading `req.membership.role`), not a separate guard
 *          class, mirroring the plan's documented design note.
 *
 *   GET    /workspaces/:workspaceId/object-types/:objectType/fields
 *          -> 200 { fieldDefinitions: [...] }
 *          NOT admin-gated: any workspace member may list. Returns only
 *          ACTIVE (non-archived) field definitions for that
 *          workspace+objectType. This PR does NOT assert on role-based
 *          `hidden`-filtering of the definitions list itself (ambiguous/
 *          deferred per the task's instructions) — only that the defined
 *          fields are present for a normal member caller. List order is not
 *          asserted; only set membership.
 *
 *   PATCH  /workspaces/:workspaceId/object-types/:objectType/fields/:fieldDefinitionId
 *          -> 200 { fieldDefinition }
 *          body: { label?, config?, defaultValue?, permissions? }
 *          ADMIN-GATED like POST.
 *
 *   POST   /workspaces/:workspaceId/object-types/:objectType/fields/:fieldDefinitionId/archive
 *          -> 200 { fieldDefinition } with lifecycle: 'archived'
 *          ADMIN-GATED like POST.
 *
 * A nonexistent `fieldDefinitionId`, OR one that exists but belongs to a
 * *different* workspace than the one in the URL, -> 404 on PATCH/archive
 * (same double-duty existence+scope lookup pattern as `objects_view`, per
 * ADR-0003).
 *
 * Defining the same `key` twice in the same `(workspaceId, objectType)` ->
 * 409 (`ConflictError`, same unique-constraint-catch pattern as
 * `WorkspacesService.createWorkspace`'s slug conflict).
 *
 * An invalid `fieldType` (not one of the 12), an invalid/incomplete `config`
 * (e.g. `select` with missing/empty `config.options`), a `defaultValue` that
 * doesn't validate against its own type/config (e.g. `select` default not in
 * `options`), or `permissions` missing a role / containing an invalid level
 * string -> 400 (`ValidationError`, thrown by PR-A's `defineField`/
 * `updateField`).
 *
 * Updating or archiving an ALREADY-archived field definition -> 409
 * (`InvalidObjectStateError`, from PR-A's `updateField`/`archiveField`).
 *
 * `:objectType` in the URL must be one of `task`/`doc`/`note`. DESIGN
 * DECISION (pinned here): an unknown value (e.g. `'bogus'`) -> 400, treated
 * as a malformed path segment analogous to a DTO validation failure (NOT
 * 404 — the route itself exists, only the segment's value is invalid; NOT
 * 422 — this codebase's convention, per `objects.integration.test.ts`'s own
 * "unknown objectType -> 400" precedent at the request-body level, is that
 * unknown-enum-value rejections are 400s throughout).
 * ---------------------------------------------------------------------------
 *
 * DESIGN NOTES locked in for `implementer` (mirroring this file's own
 * "design notes" style, per CLAUDE.md's TDD ritual):
 * - `FieldDefinitionsService` follows `ObjectsService`'s exact internal
 *   pattern: its own `applyCommand`/`wrapDrafts`/`lookupStreamId` private
 *   helpers, `STREAM_TYPE = 'field-definition'`, a stable
 *   `FieldDefinitionsViewProjection` instance field, synchronous
 *   `ProjectionRunner.catchUp` after every write for read-your-writes.
 * - `actor` for every command is `{ type: 'user', id: req.user.id }` — same
 *   minimal actor convention as `ObjectsController`.
 * - There is currently NO HTTP endpoint to invite/add a member with a
 *   non-owner role (no `WorkspacesController` invite route exists yet), so
 *   this test file inserts `memberships` rows DIRECTLY via a raw
 *   `createDatabaseClient` connection (mirroring
 *   `../event-store/event-store.integration.test.ts`'s established pattern
 *   of reaching into the DB directly for test setup that has no HTTP
 *   surface) to create admin/member/guest fixtures. This is test-fixture
 *   plumbing only, not part of the pinned API contract above.
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
  workspaceId: string;
  objectType: string;
  key: string;
  label: string;
  fieldType: string;
  config: unknown;
  defaultValue?: unknown;
  permissions: FieldPermissionsBody;
  lifecycle: string;
  createdAt: string;
  updatedAt: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface FieldDefinitionListEnvelope {
  fieldDefinitions: FieldDefinitionBody[];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

/** ULID shape: 26 Crockford-base32 characters (no I/L/O/U). */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim, per this task's instructions). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

/** All 4 roles get `edit` — the permissive default used by tests that don't
 * care about permission filtering, only about define/update/archive/list
 * mechanics. */
const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

let emailCounter = 0;

/** Generates a fresh, never-reused email per call so tests can register
 * independent users without colliding on the `email` unique constraint. */
function freshEmail(): string {
  emailCounter += 1;
  return `fields-test-user-${String(emailCounter)}@example.com`;
}

describe('Field Definitions (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // Imported only after DATABASE_URL/REDIS_URL are set, per
    // `tenant-isolation.integration.test.ts`'s established convention.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;

    // A separate raw connection, used ONLY to insert `memberships` fixture
    // rows directly (no HTTP invite endpoint exists yet) — see this file's
    // header "DESIGN NOTES".
    rawDb = createDatabaseClient(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  /** Registers a brand-new user and returns their session cookie + id. */
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

  /** Creates a workspace as the given (cookie-authenticated) user and
   * returns its id. The creator is always `owner`. */
  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  /** Registers a fresh user + a fresh workspace they own (role: `owner`,
   * which passes the admin-gate), in one call. */
  async function registerAdminWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  /** Registers a brand-new user and inserts a `memberships` row for them in
   * `workspaceId` with the given role, DIRECTLY via the raw DB connection
   * (no HTTP invite endpoint exists yet). Returns their session cookie. */
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

  it('POST defines a field as an admin (owner): 201, pinned response shape, lifecycle "active"', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'nickname',
        label: 'Nickname',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(response.status).toBe(201);

    const { fieldDefinition } = response.body as FieldDefinitionEnvelope;

    expect(fieldDefinition.id).toMatch(ULID_PATTERN);
    expect(fieldDefinition.workspaceId).toBe(workspaceId);
    expect(fieldDefinition.objectType).toBe('task');
    expect(fieldDefinition.key).toBe('nickname');
    expect(fieldDefinition.label).toBe('Nickname');
    expect(fieldDefinition.fieldType).toBe('text');
    expect(fieldDefinition.lifecycle).toBe('active');
    expect(fieldDefinition.permissions).toEqual(EDIT_ALL_PERMISSIONS);
    expect(new Date(fieldDefinition.createdAt).toString()).not.toBe('Invalid Date');
    expect(new Date(fieldDefinition.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('POST is admin-gated: a "member" caller gets 403, a "guest" caller gets 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const memberResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', memberCookie)
      .send({
        key: 'blocked-by-member',
        label: 'Blocked',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(memberResponse.status).toBe(403);

    const guestResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', guestCookie)
      .send({
        key: 'blocked-by-guest',
        label: 'Blocked',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(guestResponse.status).toBe(403);

    // Sanity: the admin (owner) themself is unaffected.
    const adminResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminCookie)
      .send({
        key: 'allowed-for-admin',
        label: 'Allowed',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(adminResponse.status).toBe(201);
  });

  it('an explicit "admin" role (not just "owner") also passes the admin-gate on POST/PATCH/archive', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const adminMemberCookie = await addMemberWithRole(workspaceId, 'admin');

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminMemberCookie)
      .send({
        key: 'admin-role-can-define',
        label: 'Admin role field',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(defineResponse.status).toBe(201);
    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}`)
      .set('Cookie', adminMemberCookie)
      .send({ label: 'Renamed by admin-role member' });

    expect(patchResponse.status).toBe(200);

    const archiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', adminMemberCookie)
      .send();

    expect(archiveResponse.status).toBe(200);
  });

  it('GET lists active field definitions for a normal member (not admin-gated)', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminCookie)
      .send({
        key: 'priority',
        label: 'Priority',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(defineResponse.status).toBe(201);

    const listResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', memberCookie);

    expect(listResponse.status).toBe(200);
    const keys = (listResponse.body as FieldDefinitionListEnvelope).fieldDefinitions.map(
      (fd) => fd.key,
    );
    expect(keys).toContain('priority');
  });

  it('full lifecycle: PATCH updates a field definition (read-your-writes); archive removes it from GET / list', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'status',
        label: 'Status',
        fieldType: 'select',
        config: { options: ['todo', 'doing', 'done'] },
        defaultValue: 'todo',
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(defineResponse.status).toBe(201);
    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}`)
      .set('Cookie', cookie)
      .send({ label: 'Task Status' });

    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as FieldDefinitionEnvelope).fieldDefinition.label).toBe(
      'Task Status',
    );

    // Read-your-writes: GET / list reflects the label change with no
    // artificial delay (proves synchronous `ProjectionRunner.catchUp`).
    const listAfterPatch = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie);

    const patchedEntry = (listAfterPatch.body as FieldDefinitionListEnvelope).fieldDefinitions.find(
      (fd) => fd.id === fieldDefinitionId,
    );
    expect(patchedEntry?.label).toBe('Task Status');

    const archiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(archiveResponse.status).toBe(200);
    expect((archiveResponse.body as FieldDefinitionEnvelope).fieldDefinition.lifecycle).toBe(
      'archived',
    );

    // GET / only returns ACTIVE field definitions — the archived one must
    // disappear from the list.
    const listAfterArchive = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie);

    const archivedEntry = (
      listAfterArchive.body as FieldDefinitionListEnvelope
    ).fieldDefinitions.find((fd) => fd.id === fieldDefinitionId);
    expect(archivedEntry).toBeUndefined();
  });

  it('PATCH is admin-gated: a "member" caller gets 403; archive is admin-gated: a "member" caller gets 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminCookie)
      .send({
        key: 'assignee',
        label: 'Assignee',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}`)
      .set('Cookie', memberCookie)
      .send({ label: 'Should not apply' });

    expect(patchResponse.status).toBe(403);

    const archiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', memberCookie)
      .send();

    expect(archiveResponse.status).toBe(403);
  });

  it('a nonexistent fieldDefinitionId returns 404 on PATCH and archive', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    // Syntactically ULID-shaped but never actually created.
    const nonexistentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${nonexistentId}`)
      .set('Cookie', cookie)
      .send({ label: 'Whatever' });
    expect(patchResponse.status).toBe(404);

    const archiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${nonexistentId}/archive`)
      .set('Cookie', cookie)
      .send();
    expect(archiveResponse.status).toBe(404);
  });

  it("cross-tenant scoping: a fieldDefinitionId from workspace A returns 404 through workspace B's URL", async () => {
    const { cookie, workspaceId: workspaceAId } = await registerAdminWithWorkspace();

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceAId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'belongs-to-a',
        label: 'Belongs to A',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    // A second, unrelated workspace owned by the SAME user (this is about
    // field-definition scoping-by-workspace, not membership).
    const workspaceBId = await createWorkspace(cookie, 'Workspace B (unrelated)');

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceBId, 'task')}/${fieldDefinitionId}`)
      .set('Cookie', cookie)
      .send({ label: 'Should not apply' });

    expect(patchResponse.status).toBe(404);

    const archiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceBId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(archiveResponse.status).toBe(404);

    // Still perfectly reachable through its real workspace.
    const ownWorkspaceListResponse = await request(server)
      .get(fieldsUrl(workspaceAId, 'task'))
      .set('Cookie', cookie);

    expect(ownWorkspaceListResponse.status).toBe(200);
  });

  it('defining the same key twice in the same workspace+objectType returns 409 (ConflictError)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const firstResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'duplicate-key',
        label: 'First',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(firstResponse.status).toBe(201);

    const secondResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'duplicate-key',
        label: 'Second (conflicts)',
        fieldType: 'number',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(secondResponse.status).toBe(409);
  });

  it('the same key is allowed again for a DIFFERENT objectType in the same workspace (uniqueness is per workspace+objectType)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const taskResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'shared-key',
        label: 'Task field',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(taskResponse.status).toBe(201);

    const docResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'doc'))
      .set('Cookie', cookie)
      .send({
        key: 'shared-key',
        label: 'Doc field',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(docResponse.status).toBe(201);
  });

  it('defining a field with an invalid fieldType (not one of the 12) returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'bogus-type-field',
        label: 'Bogus',
        fieldType: 'bogus',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(response.status).toBe(400);
  });

  it('defining a "select" field with config.options missing returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'select-missing-options',
        label: 'Select',
        fieldType: 'select',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(response.status).toBe(400);
  });

  it('defining a "select" field with an EMPTY config.options array returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'select-empty-options',
        label: 'Select',
        fieldType: 'select',
        config: { options: [] },
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(response.status).toBe(400);
  });

  it('defining a field with a defaultValue that does not validate against its own type/config returns 400 (select default not in options)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'select-bad-default',
        label: 'Select',
        fieldType: 'select',
        config: { options: ['a', 'b'] },
        defaultValue: 'not-an-option',
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(response.status).toBe(400);
  });

  it('defining a "number" field with a non-number defaultValue returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'number-bad-default',
        label: 'Number',
        fieldType: 'number',
        config: {},
        defaultValue: 'not-a-number',
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(response.status).toBe(400);
  });

  it('defining a field with permissions missing a role returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'missing-role-permissions',
        label: 'Missing role',
        fieldType: 'text',
        config: {},
        permissions: { owner: 'edit', admin: 'edit', member: 'edit' }, // guest missing
      });

    expect(response.status).toBe(400);
  });

  it('defining a field with an invalid permission level string returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'invalid-level-permissions',
        label: 'Invalid level',
        fieldType: 'text',
        config: {},
        permissions: { owner: 'edit', admin: 'edit', member: 'edit', guest: 'not-a-real-level' },
      });

    expect(response.status).toBe(400);
  });

  it('updating an already-archived field definition returns 409 (InvalidObjectStateError)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'archive-then-update',
        label: 'Will be archived',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    const archiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(archiveResponse.status).toBe(200);

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}`)
      .set('Cookie', cookie)
      .send({ label: 'Should not apply to an archived field' });

    expect(patchResponse.status).toBe(409);
  });

  it('archiving an already-archived field definition returns 409', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'double-archive',
        label: 'Will be archived twice',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    const firstArchiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(firstArchiveResponse.status).toBe(200);

    const secondArchiveResponse = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(secondArchiveResponse.status).toBe(409);
  });

  it('an invalid :objectType path segment (not task/doc/note) returns 400 on POST and GET', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const postResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'bogus'))
      .set('Cookie', cookie)
      .send({
        key: 'irrelevant',
        label: 'Irrelevant',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

    expect(postResponse.status).toBe(400);

    const getResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'bogus'))
      .set('Cookie', cookie);

    expect(getResponse.status).toBe(400);
  });

  it('guard stack: unauthenticated requests are rejected with 401, non-members with 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerAdminWithWorkspace();

    const noSessionResponse = await request(server).get(fieldsUrl(workspaceId, 'task'));
    expect(noSessionResponse.status).toBe(401);

    const { cookie: outsiderCookie } = await registerUser();
    const outsiderResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', outsiderCookie);
    expect(outsiderResponse.status).toBe(403);

    // Sanity: the owner themself is unaffected by the above.
    const ownerResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', ownerCookie);
    expect(ownerResponse.status).toBe(200);
  });
});
