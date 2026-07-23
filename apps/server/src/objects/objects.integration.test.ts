import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T1 PR-B, AC #4 (+ the API half of AC #3): real, end-to-end integration
 * test for the Lumina Object CRUD + lifecycle HTTP surface. Nothing here is
 * mocked — a throwaway Postgres 16 + Redis 7 pair is started via
 * Testcontainers, migrations run for real, and the actual `AppModule` is
 * booted and driven purely over HTTP with `supertest`, mirroring
 * `../auth/tenant-isolation.integration.test.ts`'s pattern exactly (same
 * container setup, same dynamic `import('../app.module.js')` AFTER
 * `DATABASE_URL`/`REDIS_URL` are set, same `toCookieHeader` helper).
 *
 * ============================================================================
 * RED STATE (expected, today): `AppModule` (`../app.module.ts`) does not yet
 * import an `ObjectsModule` — there is no `objects.module.ts`,
 * `objects.controller.ts`, `objects.service.ts`, `objects-view.projection.ts`,
 * or `event-store.module.ts` yet (PR-A only built the pure domain in
 * `packages/core-objects`; none of that is wired into the server). Every
 * request below to `/workspaces/:workspaceId/objects...` is therefore
 * expected to 404 via Nest's own default "Cannot POST/GET ..." handler
 * (there is no matching route at all), NOT via `AppErrorFilter` mapping an
 * `AppError` — this file's assertions will fail with e.g. "expected 404 to be
 * 201" or similar because the body won't be `{ object: {...} }` but Nest's
 * default `{"message":"Cannot POST /workspaces/.../objects","error":"Not
 * Found","statusCode":404}` shape. That is the correct red: it means the
 * ROUTE doesn't exist yet, not that test logic itself is wrong. `implementer`
 * must add `EventStoreModule` + `ObjectsModule` (imported by `AppModule`) to
 * turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/objects')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` (identical guard stack to
 * `WorkspacesController`'s `:workspaceId` routes).
 *
 *   POST   /workspaces/:workspaceId/objects            -> 201 { object }
 *   GET    /workspaces/:workspaceId/objects             -> 200 { objects: [...] }
 *   GET    /workspaces/:workspaceId/objects/:objectId   -> 200 { object }
 *   PATCH  /workspaces/:workspaceId/objects/:objectId   -> 200 { object }  (body: { title })
 *   POST   /workspaces/:workspaceId/objects/:objectId/archive  -> 200 { object }
 *   POST   /workspaces/:workspaceId/objects/:objectId/restore  -> 200 { object }
 *   DELETE /workspaces/:workspaceId/objects/:objectId   -> 204 (no body)
 *
 * Status code choices, decided here (pinning for implementer):
 * - `archive`/`restore` return 200 + the updated object body (consistent
 *   with `PATCH`'s "body-returning mutation" precedent) rather than 204,
 *   because the caller needs the fresh `lifecycle`/`updatedAt` without an
 *   extra GET round-trip (this is also what makes the read-your-writes
 *   assertions below possible without a second request).
 * - `DELETE` (soft-delete) returns 204 with no body, consistent with
 *   `auth.controller.ts`'s `/logout` precedent for a no-content-returning
 *   mutation — there is nothing meaningful to return after a delete (the
 *   caller already knows the id it deleted, and the object's new
 *   `lifecycle: 'deleted'` state is not something callers need echoed back
 *   to confirm the mutation succeeded, unlike archive/restore which the
 *   caller may want to display /  chain to a fresh command).
 *
 * `object` response shape (at least): `{ id, type, title, workspaceId,
 * createdBy, createdAt, updatedAt, lifecycle }` — `id` is a ULID (26
 * Crockford-base32 chars), NOT the internal `streamId` (uuid), per
 * ADR-0003's id strategy.
 *
 * A nonexistent `objectId`, OR an `objectId` that exists but belongs to a
 * *different* workspace than the one in the URL, -> 404 on every route that
 * takes `:objectId` (the `objectId -> streamId` lookup in `objects_view`
 * does double duty: existence AND workspace-scope, per ADR-0003).
 *
 * A command against a `deleted` object (any of PATCH/archive/restore-not-
 * applicable/DELETE-again) -> 409, EXCEPT `restore`, which is the only
 * command a deleted object accepts (`InvalidObjectStateError`, per PR-A).
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectEnvelope {
  object: {
    id: string;
    type: string;
    title: string;
    workspaceId: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    lifecycle: string;
  };
}

interface ObjectListEnvelope {
  objects: ObjectEnvelope['object'][];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

/** ULID shape: 26 Crockford-base32 characters (no I/L/O/U). Case-insensitive
 * because implementations may emit either case; `ulid()` itself emits
 * uppercase. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim, per this task's instructions). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

/** Generates a fresh, never-reused email per call so tests can register
 * independent users without colliding on the `email` unique constraint. */
function freshEmail(): string {
  emailCounter += 1;
  return `objects-test-user-${String(emailCounter)}@example.com`;
}

describe('Lumina Objects (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // Imported only after DATABASE_URL/REDIS_URL are set, per
    // `tenant-isolation.integration.test.ts`'s established convention.
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

  /** Registers a brand-new user and returns their session cookie header. */
  async function registerUser(): Promise<string> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    return toCookieHeader(response.get('Set-Cookie'));
  }

  /** Creates a workspace as the given (cookie-authenticated) user and
   * returns its id. */
  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  /** Registers a fresh user + a fresh workspace they own, in one call — the
   * common setup most of the tests below need. */
  async function registerUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  it('POST creates an object: 201, pinned response shape, lifecycle starts "active"', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Write the launch checklist' });

    expect(response.status).toBe(201);

    const { object } = response.body as ObjectEnvelope;

    expect(object.id).toMatch(ULID_PATTERN);
    expect(object.type).toBe('task');
    expect(object.title).toBe('Write the launch checklist');
    expect(object.lifecycle).toBe('active');
    expect(object.workspaceId).toBe(workspaceId);
    expect(typeof object.createdBy).toBe('string');
    expect(object.createdBy.length).toBeGreaterThan(0);
    expect(new Date(object.createdAt).toString()).not.toBe('Invalid Date');
    expect(new Date(object.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('GET single retrieves the created object; GET list includes it (read-your-writes, no artificial delay)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'doc', title: 'Onboarding doc' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    const getResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ObjectEnvelope).object.id).toBe(objectId);
    expect((getResponse.body as ObjectEnvelope).object.title).toBe('Onboarding doc');

    const listResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const listedIds = (listResponse.body as ObjectListEnvelope).objects.map((o) => o.id);
    expect(listedIds).toContain(objectId);
  });

  it('PATCH renames an object: 200, updated title immediately visible on a subsequent GET', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'note', title: 'Draft title' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    const renameResponse = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie)
      .send({ title: 'Final title' });

    expect(renameResponse.status).toBe(200);
    expect((renameResponse.body as ObjectEnvelope).object.title).toBe('Final title');

    // Read-your-writes: chained GET with no artificial delay must reflect
    // the rename (proves the synchronous `ProjectionRunner.catchUp` per
    // ADR-0003, exercised as an observable end result rather than an
    // implementation-detail assertion).
    const getResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ObjectEnvelope).object.title).toBe('Final title');
  });

  it('archive keeps the object visible in the list — only its lifecycle field changes (per ADR-0003, only "deleted" is list-excluded)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Archive me' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    const archiveResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(archiveResponse.status).toBe(200);
    expect((archiveResponse.body as ObjectEnvelope).object.lifecycle).toBe('archived');

    const listResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const listed = (listResponse.body as ObjectListEnvelope).objects.find((o) => o.id === objectId);

    // Explicit assertion of the design decision: archived objects are NOT
    // excluded from the list, unlike deleted ones (tested separately below).
    expect(listed).toBeDefined();
    expect(listed?.lifecycle).toBe('archived');
  });

  it('restore returns an archived object to "active"; it can be renamed and re-archived again afterwards', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Archive then restore me' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/archive`)
      .set('Cookie', cookie)
      .send();

    const restoreResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/restore`)
      .set('Cookie', cookie)
      .send();

    expect(restoreResponse.status).toBe(200);
    expect((restoreResponse.body as ObjectEnvelope).object.lifecycle).toBe('active');

    // Proves the object is genuinely usable again, not just flagged active:
    // a normal command succeeds post-restore.
    const renameResponse = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie)
      .send({ title: 'Restored and renamed' });

    expect(renameResponse.status).toBe(200);
    expect((renameResponse.body as ObjectEnvelope).object.title).toBe('Restored and renamed');

    // And it can be archived again (active -> archived transition still legal).
    const secondArchiveResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(secondArchiveResponse.status).toBe(200);
    expect((secondArchiveResponse.body as ObjectEnvelope).object.lifecycle).toBe('archived');
  });

  it('an invalid lifecycle transition on a non-deleted object (double-archive) returns 409, matching InvalidObjectStateError', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Double archive me' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/archive`)
      .set('Cookie', cookie)
      .send();

    // Already archived: archiving again is not a legal transition
    // (`canTransition` only allows active -> archived).
    const secondArchiveResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(secondArchiveResponse.status).toBe(409);
  });

  it('DELETE soft-deletes an object: 204, and it disappears from the list', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Delete me' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    const deleteResponse = await request(server)
      .delete(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const listedIds = (listResponse.body as ObjectListEnvelope).objects.map((o) => o.id);
    expect(listedIds).not.toContain(objectId);
  });

  it('a command against a deleted object returns 409; after restore, commands work again (AC #3, API half)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Delete then rename me' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    await request(server)
      .delete(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    // Every command except `restore` is rejected on a deleted object.
    const renameAfterDeleteResponse = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie)
      .send({ title: 'Should not apply' });

    expect(renameAfterDeleteResponse.status).toBe(409);

    const archiveAfterDeleteResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/archive`)
      .set('Cookie', cookie)
      .send();

    expect(archiveAfterDeleteResponse.status).toBe(409);

    // `restore` is the one command a deleted object accepts.
    const restoreResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/restore`)
      .set('Cookie', cookie)
      .send();

    expect(restoreResponse.status).toBe(200);
    expect((restoreResponse.body as ObjectEnvelope).object.lifecycle).toBe('active');

    // Commands work again post-restore — proves the restore-then-command-
    // works invariant end-to-end through the real event store + projection,
    // not just at the domain-unit-test level (which PR-A already covers).
    const renameAfterRestoreResponse = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie)
      .send({ title: 'Alive again' });

    expect(renameAfterRestoreResponse.status).toBe(200);
    expect((renameAfterRestoreResponse.body as ObjectEnvelope).object.title).toBe('Alive again');

    // And it's visible in the list again, since it's no longer "deleted".
    const listResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie);

    const listedIds = (listResponse.body as ObjectListEnvelope).objects.map((o) => o.id);
    expect(listedIds).toContain(objectId);
  });

  it('a nonexistent objectId returns 404 on GET/PATCH/archive/restore/DELETE', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    // Syntactically ULID-shaped but never actually created.
    const nonexistentObjectId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const getResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects/${nonexistentObjectId}`)
      .set('Cookie', cookie);
    expect(getResponse.status).toBe(404);

    const patchResponse = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${nonexistentObjectId}`)
      .set('Cookie', cookie)
      .send({ title: 'Whatever' });
    expect(patchResponse.status).toBe(404);

    const archiveResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${nonexistentObjectId}/archive`)
      .set('Cookie', cookie)
      .send();
    expect(archiveResponse.status).toBe(404);

    const restoreResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${nonexistentObjectId}/restore`)
      .set('Cookie', cookie)
      .send();
    expect(restoreResponse.status).toBe(404);

    const deleteResponse = await request(server)
      .delete(`/workspaces/${workspaceId}/objects/${nonexistentObjectId}`)
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(404);

    // Defensive: a syntactically bogus (non-ULID-shaped) id must also 404,
    // not 500 — the objectId -> streamId lookup is a plain varchar equality
    // match (unlike workspaceId, which is a uuid column requiring explicit
    // format guarding against a raw driver exception), so any string is
    // safe to look up and simply won't match.
    const garbageResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects/not-a-ulid-at-all`)
      .set('Cookie', cookie);
    expect(garbageResponse.status).toBe(404);
  });

  it("cross-tenant scoping (AC #4): a second workspace cannot see or reach the first workspace's objects", async () => {
    const { cookie, workspaceId: workspaceAId } = await registerUserWithWorkspace();

    const createResponse = await request(server)
      .post(`/workspaces/${workspaceAId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Belongs only to workspace A' });

    const objectId = (createResponse.body as ObjectEnvelope).object.id;

    // A second, unrelated workspace (same user is fine — this test is about
    // object-scoping-by-workspace, not membership, which is already covered
    // by `../auth/tenant-isolation.integration.test.ts`).
    const workspaceBId = await createWorkspace(cookie, 'Workspace B (unrelated)');

    const listResponse = await request(server)
      .get(`/workspaces/${workspaceBId}/objects`)
      .set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const listedIds = (listResponse.body as ObjectListEnvelope).objects.map((o) => o.id);
    expect(listedIds).not.toContain(objectId);

    // Directly requesting workspace A's object through workspace B's URL
    // must 404 — not 403 (this is "the object genuinely doesn't exist in
    // this workspace's scope", not a membership failure).
    const crossWorkspaceGetResponse = await request(server)
      .get(`/workspaces/${workspaceBId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(crossWorkspaceGetResponse.status).toBe(404);

    // The object is still perfectly reachable through its real workspace.
    const ownWorkspaceGetResponse = await request(server)
      .get(`/workspaces/${workspaceAId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(ownWorkspaceGetResponse.status).toBe(200);
  });

  it('validation: an empty title for a "task" (title-required) object returns 400', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: '' });

    expect(response.status).toBe(400);
  });

  it('validation: an unknown objectType is rejected at the DTO level with 400', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'bogus', title: 'Whatever' });

    expect(response.status).toBe(400);
  });

  it('validation is parametric per object type: "doc" and "note" allow an empty title (object-type registry, per ADR-0003)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    const docResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'doc', title: '' });

    expect(docResponse.status).toBe(201);
    expect((docResponse.body as ObjectEnvelope).object.title).toBe('');

    const noteResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'note', title: '' });

    expect(noteResponse.status).toBe(201);
    expect((noteResponse.body as ObjectEnvelope).object.title).toBe('');
  });

  it('guard stack: unauthenticated requests are rejected with 401, non-members with 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerUserWithWorkspace();

    const noSessionResponse = await request(server).get(`/workspaces/${workspaceId}/objects`);
    expect(noSessionResponse.status).toBe(401);

    const outsiderCookie = await registerUser();
    const outsiderResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', outsiderCookie);
    expect(outsiderResponse.status).toBe(403);

    // Sanity: the owner themself is unaffected by the above.
    const ownerResponse = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', ownerCookie);
    expect(ownerResponse.status).toBe(200);
  });
});
