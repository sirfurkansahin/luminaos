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
 * F1-T9 PR1 (backend): real, end-to-end integration test for the SavedView
 * CRUD HTTP surface (`SavedViewsService`/`SavedViewsController`), mirroring
 * `../fields/field-definitions.integration.test.ts`'s pattern exactly (same
 * Testcontainers Postgres 16 + Redis 7 pair, same dynamic
 * `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL` are set, same
 * `toCookieHeader` helper copied verbatim). Nothing here is mocked.
 *
 * This is backend-only (PR1) — the frontend (`apiClient`, hooks, IconPicker,
 * SavedViewsList, App.tsx/CalendarView/TimelineView prop wiring) is F1-T9
 * PR2's job and is NOT tested here.
 *
 * ============================================================================
 * RED STATE (expected, today): `AppModule` (`../app.module.ts`) does not yet
 * import a `SavedViewsModule` — there is no `saved-views.module.ts`,
 * `saved-views.controller.ts`, `saved-views.service.ts`,
 * `saved-views.projection.ts`, or `saved_views` DB table/schema yet (this PR
 * builds the pure domain in `packages/core-objects/src/saved-views/` and this
 * server layer together; neither is wired in yet). Every request below to
 * `/workspaces/:workspaceId/views...` is therefore expected to 404 via Nest's
 * own default "Cannot POST/GET/PATCH/DELETE ..." handler (there is no
 * matching route at all), NOT via `AppErrorFilter` mapping an `AppError` —
 * assertions below will fail with e.g. "expected 404 to be 201" and the body
 * will be Nest's default `{"message":"Cannot POST /workspaces/.../views",
 * "error":"Not Found","statusCode":404}` shape rather than
 * `{ savedView: {...} }`. That is the correct red: it means the ROUTE doesn't
 * exist yet, not that the test logic itself is wrong. `implementer` must add
 * the `saved_views` migration + `SavedViewsModule` (imported by `AppModule`)
 * to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/views')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level
 * (identical guard stack to `RelationsController`/`FieldsController`).
 *
 *   POST   /workspaces/:workspaceId/views
 *          body: { name, icon, viewType, objectType, querySpec, dateField?,
 *                  startField?, endField?, shared: boolean }
 *          -> 201 { savedView }
 *          The server derives `ownerId` itself, NEVER trusting a client-sent
 *          value (not even part of the DTO): `shared: true` -> `ownerId:
 *          null`; `shared: false` -> `ownerId: req.user.id`.
 *          `shared: true` (creating a WORKSPACE-WIDE view) is ADMIN-GATED:
 *          member/guest callers -> 403.
 *          `shared: false` (a personal view) is open to ANY workspace member
 *          (including guest) — NOT admin-gated.
 *
 *   GET    /workspaces/:workspaceId/views?objectType=task
 *          -> 200 { savedViews: [...] }
 *          Returns only `lifecycle: 'active'` views for that objectType where
 *          `ownerId IS NULL OR ownerId = caller's own id` — a personal view
 *          belonging to a DIFFERENT member must be ABSENT from this list
 *          (spec AC#2, the core visibility test). Not admin-gated.
 *
 *   PATCH  /workspaces/:workspaceId/views/:savedViewId
 *          body (partial): { name?, icon?, querySpec?, dateField?,
 *                             startField?, endField? }
 *          -> 200 { savedView }
 *          PERMISSION BRANCH (the genuinely new thing this task adds, no
 *          existing precedent to copy): if the target view's `ownerId !==
 *          null` (personal) -> ONLY that owner may PATCH; ANY other caller,
 *          INCLUDING a workspace admin/owner, -> 403 (ownership beats role
 *          rank for personal views). If `ownerId === null` (shared) -> ONLY
 *          `hasAtLeastRole(callerRole, 'admin')` may PATCH -> member/guest
 *          get 403.
 *
 *   DELETE /workspaces/:workspaceId/views/:savedViewId
 *          -> 204, same permission branch as PATCH.
 *          Soft-delete: sets `lifecycle: 'deleted'` (NOT a hard row delete,
 *          same discipline as `FieldArchived` — see
 *          `field-definitions.projection.ts`'s `FieldArchived` handler) — a
 *          subsequent GET list must no longer include it.
 *
 * A nonexistent `savedViewId`, OR one that exists but belongs to a
 * *different* workspace than the one in the URL, -> 404 on PATCH/DELETE (same
 * double-duty existence+scope lookup pattern as `field_definitions`/
 * `relations_view`).
 *
 * An invalid `viewType` (not one of the 5) or a missing/empty `name` on
 * create -> 400 (`ValidationError`, thrown by the domain's `createSavedView`).
 * ---------------------------------------------------------------------------
 *
 * DESIGN NOTES locked in for `implementer` (mirroring
 * `field-definitions.integration.test.ts`'s own "design notes" style, per
 * CLAUDE.md's TDD ritual):
 * - `SavedViewsService` follows `FieldDefinitionsService`'s/
 *   `RelationsService`'s exact internal pattern: its own `wrapDrafts`/
 *   `lookupStreamId` private helpers, `STREAM_TYPE = 'saved-view'`, a stable
 *   `SavedViewsViewProjection` instance field, synchronous
 *   `ProjectionRunner.catchUp` after every write for read-your-writes.
 * - The permission check (ownership-vs-role) lives in the SERVICE, after
 *   `replaySavedView`, not in the controller — closing a TOCTOU window
 *   between checking and acting.
 * - `actor` for every command is `{ type: 'user', id: req.user.id }` — same
 *   minimal actor convention as `ObjectsController`/`RelationsController`.
 * - There is currently NO HTTP endpoint to invite/add a member with a
 *   non-owner role, so this test file inserts `memberships` rows DIRECTLY via
 *   a raw `createDatabaseClient` connection (mirroring
 *   `field-definitions.integration.test.ts`'s established pattern) to create
 *   admin/member/guest fixtures. This is test-fixture plumbing only, not part
 *   of the pinned API contract above.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface QuerySpecBody {
  objectType: string;
  filters: unknown[];
}

interface SavedViewBody {
  id: string;
  workspaceId: string;
  objectType: string;
  name: string;
  icon: string;
  viewType: string;
  querySpec: QuerySpecBody;
  dateField?: string;
  startField?: string;
  endField?: string;
  ownerId: string | null;
  lifecycle: string;
  createdAt: string;
  updatedAt: string;
}

interface SavedViewEnvelope {
  savedView: SavedViewBody;
}

interface SavedViewListEnvelope {
  savedViews: SavedViewBody[];
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
 * behind this exact helper (copied verbatim, per this task's instructions,
 * same as `field-definitions.integration.test.ts`). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

const BASE_QUERY_SPEC: QuerySpecBody = { objectType: 'task', filters: [] };

let emailCounter = 0;

/** Generates a fresh, never-reused email per call so tests can register
 * independent users without colliding on the `email` unique constraint. */
function freshEmail(): string {
  emailCounter += 1;
  return `saved-views-test-user-${String(emailCounter)}@example.com`;
}

describe('Saved Views (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
    // `field-definitions.integration.test.ts`'s established convention.
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
  async function registerAdminWithWorkspace(): Promise<{
    cookie: string;
    workspaceId: string;
    userId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId, userId };
  }

  /** Registers a brand-new user and inserts a `memberships` row for them in
   * `workspaceId` with the given role, DIRECTLY via the raw DB connection
   * (no HTTP invite endpoint exists yet). Returns their session cookie + id. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();

    await rawDb.insert(memberships).values({ workspaceId, userId, role });

    return { cookie, userId };
  }

  function viewsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/views`;
  }

  function createPersonalPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: 'My personal view',
      icon: 'star',
      viewType: 'list',
      objectType: 'task',
      querySpec: BASE_QUERY_SPEC,
      shared: false,
      ...overrides,
    };
  }

  function createSharedPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Team-wide view',
      icon: 'flame',
      viewType: 'board',
      objectType: 'task',
      querySpec: BASE_QUERY_SPEC,
      shared: true,
      ...overrides,
    };
  }

  it("POST creates a personal view (shared:false): 201, ownerId equals the caller's own id (never null)", async () => {
    const { cookie, workspaceId, userId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createPersonalPayload());

    expect(response.status).toBe(201);
    const { savedView } = response.body as SavedViewEnvelope;

    expect(savedView.id).toMatch(ULID_PATTERN);
    expect(savedView.workspaceId).toBe(workspaceId);
    expect(savedView.ownerId).toBe(userId);
    expect(savedView.lifecycle).toBe('active');
  });

  it('POST creates a shared view (shared:true) as admin/owner: 201, ownerId: null', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createSharedPayload());

    expect(response.status).toBe(201);
    const { savedView } = response.body as SavedViewEnvelope;

    expect(savedView.ownerId).toBeNull();
  });

  it('POST shared:true is admin-gated: member -> 403, guest -> 403', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: guestCookie } = await addMemberWithRole(workspaceId, 'guest');

    const memberResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(createSharedPayload({ name: 'Blocked (member)' }));
    expect(memberResponse.status).toBe(403);

    const guestResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', guestCookie)
      .send(createSharedPayload({ name: 'Blocked (guest)' }));
    expect(guestResponse.status).toBe(403);
  });

  it('POST shared:false (personal creation) is unrestricted: member -> 201, guest -> 201', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: guestCookie } = await addMemberWithRole(workspaceId, 'guest');

    const memberResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(createPersonalPayload({ name: 'Member personal view' }));
    expect(memberResponse.status).toBe(201);

    const guestResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', guestCookie)
      .send(createPersonalPayload({ name: 'Guest personal view' }));
    expect(guestResponse.status).toBe(201);
  });

  it('client cannot spoof ownerId: a shared:false request with an ownerId field in the body still derives ownerId from the session', async () => {
    const { cookie, workspaceId, userId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ ...createPersonalPayload(), ownerId: 'some-other-user-id' });

    // Either the extra field is rejected outright (400, `.strict()` DTO) or
    // silently ignored server-side (201 with the caller's own id) — either
    // way, `ownerId` must never become the spoofed value.
    if (response.status === 201) {
      const { savedView } = response.body as SavedViewEnvelope;
      expect(savedView.ownerId).toBe(userId);
      expect(savedView.ownerId).not.toBe('some-other-user-id');
    } else {
      expect(response.status).toBe(400);
    }
  });

  it('GET list: a personal view is visible to its own creator, absent for a DIFFERENT member', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const { cookie: memberACookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: memberBCookie } = await addMemberWithRole(workspaceId, 'member');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', memberACookie)
      .send(createPersonalPayload({ name: 'Member A personal view' }));
    expect(createResponse.status).toBe(201);
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const ownListResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', memberACookie);
    expect(ownListResponse.status).toBe(200);
    const ownIds = (ownListResponse.body as SavedViewListEnvelope).savedViews.map((v) => v.id);
    expect(ownIds).toContain(savedViewId);

    const otherListResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', memberBCookie);
    expect(otherListResponse.status).toBe(200);
    const otherIds = (otherListResponse.body as SavedViewListEnvelope).savedViews.map((v) => v.id);
    expect(otherIds).not.toContain(savedViewId);
  });

  it('GET list: a shared view is visible to every role (owner/admin/member/guest)', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerAdminWithWorkspace();
    const { cookie: adminCookie } = await addMemberWithRole(workspaceId, 'admin');
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: guestCookie } = await addMemberWithRole(workspaceId, 'guest');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send(createSharedPayload({ name: 'Everyone sees this' }));
    expect(createResponse.status).toBe(201);
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    for (const cookie of [ownerCookie, adminCookie, memberCookie, guestCookie]) {
      const listResponse = await request(server)
        .get(`${viewsUrl(workspaceId)}?objectType=task`)
        .set('Cookie', cookie);
      expect(listResponse.status).toBe(200);
      const ids = (listResponse.body as SavedViewListEnvelope).savedViews.map((v) => v.id);
      expect(ids).toContain(savedViewId);
    }
  });

  it('PATCH a shared view as admin/owner: 200, reflects the change', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createSharedPayload());
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const patchResponse = await request(server)
      .patch(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', cookie)
      .send({ name: 'Renamed by owner' });

    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as SavedViewEnvelope).savedView.name).toBe('Renamed by owner');
  });

  it('PATCH a shared view as member -> 403; as guest -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerAdminWithWorkspace();
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: guestCookie } = await addMemberWithRole(workspaceId, 'guest');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send(createSharedPayload());
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const memberPatch = await request(server)
      .patch(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', memberCookie)
      .send({ name: 'Should not apply' });
    expect(memberPatch.status).toBe(403);

    const guestPatch = await request(server)
      .patch(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', guestCookie)
      .send({ name: 'Should not apply' });
    expect(guestPatch.status).toBe(403);
  });

  it('PATCH a personal view as its own owner: 200', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(createPersonalPayload());
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const patchResponse = await request(server)
      .patch(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', memberCookie)
      .send({ name: 'Renamed by its owner' });

    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as SavedViewEnvelope).savedView.name).toBe('Renamed by its owner');
  });

  it('PATCH a personal view as a DIFFERENT member (even an admin) -> 403 (ownership beats role rank)', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const { cookie: creatorCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: adminCookie } = await addMemberWithRole(workspaceId, 'admin');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', creatorCookie)
      .send(createPersonalPayload());
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const adminPatchResponse = await request(server)
      .patch(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', adminCookie)
      .send({ name: 'Admin should not be able to do this' });

    expect(adminPatchResponse.status).toBe(403);
  });

  it('DELETE a shared view as member -> 403; as admin -> 204, subsequent GET list excludes it', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerAdminWithWorkspace();
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: adminCookie } = await addMemberWithRole(workspaceId, 'admin');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send(createSharedPayload({ name: 'To be deleted' }));
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const memberDelete = await request(server)
      .delete(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', memberCookie);
    expect(memberDelete.status).toBe(403);

    const adminDelete = await request(server)
      .delete(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', adminCookie);
    expect(adminDelete.status).toBe(204);

    const listResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', ownerCookie);
    const ids = (listResponse.body as SavedViewListEnvelope).savedViews.map((v) => v.id);
    expect(ids).not.toContain(savedViewId);
  });

  it('DELETE a personal view as its owner: 204, subsequent GET list excludes it; as a different user: 403', async () => {
    const { workspaceId } = await registerAdminWithWorkspace();
    const { cookie: ownerMemberCookie } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: otherMemberCookie } = await addMemberWithRole(workspaceId, 'member');

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', ownerMemberCookie)
      .send(createPersonalPayload({ name: 'Personal, to be deleted' }));
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    const otherDeleteResponse = await request(server)
      .delete(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', otherMemberCookie);
    expect(otherDeleteResponse.status).toBe(403);

    const ownDeleteResponse = await request(server)
      .delete(`${viewsUrl(workspaceId)}/${savedViewId}`)
      .set('Cookie', ownerMemberCookie);
    expect(ownDeleteResponse.status).toBe(204);

    const listResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', ownerMemberCookie);
    const ids = (listResponse.body as SavedViewListEnvelope).savedViews.map((v) => v.id);
    expect(ids).not.toContain(savedViewId);
  });

  it('icon is persisted and returned exactly as sent (AC#4)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createPersonalPayload({ icon: 'rocket-launch' }));

    expect(response.status).toBe(201);
    expect((response.body as SavedViewEnvelope).savedView.icon).toBe('rocket-launch');
  });

  it('querySpec/dateField/startField/endField round-trip correctly through create -> get (calendar view)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const querySpec: QuerySpecBody = {
      objectType: 'task',
      filters: [{ field: 'priority', operator: 'equals', value: 'high' }],
    };

    const createResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(
        createPersonalPayload({
          name: 'Calendar of urgent tasks',
          viewType: 'calendar',
          querySpec,
          dateField: 'dueDate',
        }),
      );

    expect(createResponse.status).toBe(201);
    const savedView = (createResponse.body as SavedViewEnvelope).savedView;
    expect(savedView.querySpec).toEqual(querySpec);
    expect(savedView.dateField).toBe('dueDate');

    const listResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', cookie);
    const fetched = (listResponse.body as SavedViewListEnvelope).savedViews.find(
      (v) => v.id === savedView.id,
    );
    expect(fetched?.querySpec).toEqual(querySpec);
    expect(fetched?.dateField).toBe('dueDate');
  });

  it('a nonexistent savedViewId returns 404 on PATCH and DELETE', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    // Syntactically ULID-shaped but never actually created.
    const nonexistentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const patchResponse = await request(server)
      .patch(`${viewsUrl(workspaceId)}/${nonexistentId}`)
      .set('Cookie', cookie)
      .send({ name: 'Whatever' });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await request(server)
      .delete(`${viewsUrl(workspaceId)}/${nonexistentId}`)
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(404);
  });

  it("cross-workspace scoping: a savedViewId from workspace A returns 404 through workspace B's URL", async () => {
    const { cookie, workspaceId: workspaceAId } = await registerAdminWithWorkspace();

    const createResponse = await request(server)
      .post(viewsUrl(workspaceAId))
      .set('Cookie', cookie)
      .send(createPersonalPayload({ name: 'Belongs to A' }));
    const savedViewId = (createResponse.body as SavedViewEnvelope).savedView.id;

    // A second, unrelated workspace owned by the SAME user (this is about
    // saved-view scoping-by-workspace, not membership).
    const workspaceBId = await createWorkspace(cookie, 'Workspace B (unrelated)');

    const patchResponse = await request(server)
      .patch(`${viewsUrl(workspaceBId)}/${savedViewId}`)
      .set('Cookie', cookie)
      .send({ name: 'Should not apply' });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await request(server)
      .delete(`${viewsUrl(workspaceBId)}/${savedViewId}`)
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(404);

    // Still perfectly reachable through its real workspace.
    const ownWorkspaceListResponse = await request(server)
      .get(`${viewsUrl(workspaceAId)}?objectType=task`)
      .set('Cookie', cookie);
    expect(ownWorkspaceListResponse.status).toBe(200);
  });

  it('an invalid viewType (not one of the 5) on create returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createPersonalPayload({ viewType: 'bogus-view-type' }));

    expect(response.status).toBe(400);
  });

  it('a missing/empty name on create returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const missingNameResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({
        icon: 'star',
        viewType: 'list',
        objectType: 'task',
        querySpec: BASE_QUERY_SPEC,
        shared: false,
      });
    expect(missingNameResponse.status).toBe(400);

    const emptyNameResponse = await request(server)
      .post(viewsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createPersonalPayload({ name: '' }));
    expect(emptyNameResponse.status).toBe(400);
  });

  it('guard stack: unauthenticated requests are rejected with 401, non-members with 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerAdminWithWorkspace();

    const noSessionResponse = await request(server).get(`${viewsUrl(workspaceId)}?objectType=task`);
    expect(noSessionResponse.status).toBe(401);

    const { cookie: outsiderCookie } = await registerUser();
    const outsiderResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', outsiderCookie);
    expect(outsiderResponse.status).toBe(403);

    // Sanity: the owner themself is unaffected by the above.
    const ownerResponse = await request(server)
      .get(`${viewsUrl(workspaceId)}?objectType=task`)
      .set('Cookie', ownerCookie);
    expect(ownerResponse.status).toBe(200);
  });
});
