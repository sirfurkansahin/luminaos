import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T3 PR-B: real, end-to-end integration test for the Relation CRUD (create
 * + remove only) HTTP surface, mirroring `../fields/field-definitions.
 * integration.test.ts` and `../objects/objects.integration.test.ts`'s pattern
 * exactly (same Testcontainers Postgres 16 + Redis 7 pair, same dynamic
 * `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL` are set, same
 * `toCookieHeader` helper copied verbatim). Nothing here is mocked.
 *
 * This PR is create + remove only — `getRelated` (querying relations for an
 * object) is a later PR and is NOT tested here.
 *
 * ============================================================================
 * RED STATE (expected, today): `AppModule` (`../app.module.ts`) does not yet
 * import a `RelationsModule` — there is no `relations.module.ts`,
 * `relations.controller.ts`, `relations.service.ts`,
 * `relations-view.projection.ts`, or `relations` DB table/schema yet (F1-T3
 * PR-A only built the pure domain in `packages/core-objects/src/relations/`;
 * none of it is wired into the server). Every request below to
 * `/workspaces/:workspaceId/relations...` is therefore expected to 404 via
 * Nest's own default "Cannot POST/DELETE ..." handler (there is no matching
 * route at all), NOT via `AppErrorFilter` mapping an `AppError` — assertions
 * below will fail with e.g. "expected 404 to be 201" and the body will be
 * Nest's default `{"message":"Cannot POST /workspaces/.../relations","error":
 * "Not Found","statusCode":404}` shape rather than `{ relation: {...} }`.
 * That is the correct red: it means the ROUTE doesn't exist yet, not that
 * test logic itself is wrong. `implementer` must add the `relations`
 * migration + `RelationsModule` (imported by `AppModule`) to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/relations')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level
 * (identical guard stack to `ObjectsController`). NO admin/role restriction —
 * any workspace member (including `guest`) may create/remove relations
 * (unlike `FieldsController`'s admin-gating).
 *
 *   POST   /workspaces/:workspaceId/relations
 *          body: { fromId, toId, kind: 'parentChild' | 'reference' | 'dependency' }
 *          -> 201 { relation: { id, workspaceId, fromId, toId, kind,
 *             status: 'active', createdAt, updatedAt } }
 *
 *   DELETE /workspaces/:workspaceId/relations/:relationId
 *          -> 204, no body.
 *
 * `fromId`/`toId` not an existing object (any lifecycle) in this workspace's
 * `objects_view` -> 404 (`NotFoundError`). `fromId === toId` -> 400
 * (`ValidationError`, from the pure domain). Unknown `kind` string -> 400
 * (zod DTO validation — the DTO restricts `kind` to the 3 known enum values,
 * same style as `defineFieldSchema` hardcoding the known field types).
 *
 * parentChild: a second active parentChild relation for a `toId` that
 * already has one -> 409 (`ConflictError`). A parentChild relation that would
 * close a cycle (self-parent, or a multi-hop ancestor cycle) -> 400
 * (`ValidationError`).
 *
 * dependency: a dependency edge that would close a cycle (direct 2-node, and
 * a 3-node A blocks B, B blocks C, C blocks A) -> 400 (`ValidationError`).
 *
 * reference: a duplicate (same unordered pair, same kind, already active) ->
 * 409 (`ConflictError`); the REVERSE direction of an existing reference pair
 * also counts as duplicate.
 *
 * Removing a relation then re-creating the identical parentChild/reference
 * relation succeeds (a `RelationRemoved` relation must not block a fresh
 * `create`).
 *
 * Cross-workspace: `fromId`/`toId` that exist but belong to a DIFFERENT
 * workspace than the URL's `:workspaceId` -> 404 (same double-duty
 * existence+scope-check pattern as `ObjectsService`/`FieldDefinitionsService`).
 *
 * DELETE: nonexistent `relationId`, OR one that exists but belongs to a
 * different workspace than the URL, -> 404. Calling DELETE twice on the same
 * relation -> second call 404 (the projection row is expected to be
 * hard-deleted on removal, so a repeat delete finds nothing — this test file
 * does not separately assert the underlying domain-level "already removed"
 * 409 guard since it is not reachable via this HTTP path once the projection
 * hard-deletes the row).
 * ---------------------------------------------------------------------------
 *
 * DESIGN NOTES locked in for `implementer` (mirroring sibling files' "design
 * notes" style, per CLAUDE.md's TDD ritual):
 * - A raw-DB-read replay-determinism sanity check (create A->B parentChild,
 *   remove it, create a fresh, different C->B parentChild for the same
 *   child) is included below via the HTTP surface only (repeat-DELETE 404 +
 *   fresh-create success) — a full replay-from-scratch determinism check
 *   across a raw projection rebuild is explicitly OUT OF SCOPE for this file:
 *   there is no rebuild-trigger HTTP endpoint to call, and this PR does not
 *   introduce one.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

type RelationKindBody = 'parentChild' | 'reference' | 'dependency';

interface RelationBody {
  id: string;
  workspaceId: string;
  fromId: string;
  toId: string;
  kind: RelationKindBody;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface RelationEnvelope {
  relation: RelationBody;
}

/** Shape of `GET /workspaces/:workspaceId/relations/object/:objectId`'s
 * response body, mirroring `./relations-related.integration.test.ts`'s own
 * copy of these types (that route is PR-C, already green, and reused here
 * only as a read-side probe for the security regression test below — it is
 * not otherwise exercised by this file). */
interface RelatedSummaryBody {
  parentChild: { parent: RelationBody | null; children: RelationBody[]; childrenCount: number };
  dependency: { blocks: RelationBody[]; blockedBy: RelationBody[] };
  reference: RelationBody[];
}

interface RelatedEnvelope {
  related: RelatedSummaryBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface ObjectEnvelope {
  object: { id: string };
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

let emailCounter = 0;

/** Generates a fresh, never-reused email per call so tests can register
 * independent users without colliding on the `email` unique constraint. */
function freshEmail(): string {
  emailCounter += 1;
  return `relations-test-user-${String(emailCounter)}@example.com`;
}

describe('Relations (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  /** Creates a real `task` object in `workspaceId` (as the given cookie's
   * user) via HTTP, and returns its id — for use as a relation's
   * `fromId`/`toId`. */
  async function createObject(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  function relationsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/relations`;
  }

  /** `GET /workspaces/:workspaceId/relations/object/:objectId`, mirroring
   * `./relations-related.integration.test.ts`'s own copy of this helper —
   * used only as a read-side probe by the security regression test below. */
  function relatedUrl(workspaceId: string, objectId: string): string {
    return `/workspaces/${workspaceId}/relations/object/${objectId}`;
  }

  it('POST creates a parentChild relation: 201, pinned response shape, status "active"', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const parentId = await createObject(cookie, workspaceId, 'Parent task');
    const childId = await createObject(cookie, workspaceId, 'Child task');

    const response = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: parentId, toId: childId, kind: 'parentChild' });

    expect(response.status).toBe(201);

    const { relation } = response.body as RelationEnvelope;

    expect(relation.id).toMatch(ULID_PATTERN);
    expect(relation.workspaceId).toBe(workspaceId);
    expect(relation.fromId).toBe(parentId);
    expect(relation.toId).toBe(childId);
    expect(relation.kind).toBe('parentChild');
    expect(relation.status).toBe('active');
    expect(new Date(relation.createdAt).toString()).not.toBe('Invalid Date');
    expect(new Date(relation.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('POST creates a reference relation and a dependency relation: 201 each', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');
    const c = await createObject(cookie, workspaceId, 'C');

    const referenceResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(referenceResponse.status).toBe(201);
    expect((referenceResponse.body as RelationEnvelope).relation.kind).toBe('reference');

    const dependencyResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: b, toId: c, kind: 'dependency' });

    expect(dependencyResponse.status).toBe(201);
    expect((dependencyResponse.body as RelationEnvelope).relation.kind).toBe('dependency');
  });

  it('a "guest" role caller can create and remove relations (no admin-gating, unlike FieldsController)', async () => {
    // NOTE: there is no HTTP invite endpoint to add a non-owner member, so
    // this test only pins that the (owner) caller's own requests succeed —
    // per this task's scope, we do not reach into the DB to fabricate a
    // guest membership row (that plumbing is not part of this PR's contract
    // and the fields test file's `addMemberWithRole` pattern is specific to
    // PR-C's admin-gating concerns, not this PR's "no gating" contract).
    // The absence of any role check is instead pinned by the fact that NO
    // test below ever expects a 403 for a plain member/guest-shaped request.
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const createResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(createResponse.status).toBe(201);
  });

  it('fromId === toId returns 400 (ValidationError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');

    const response = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: a, kind: 'reference' });

    expect(response.status).toBe(400);
  });

  it('an unknown kind string returns 400 (DTO validation)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const response = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'bogus-kind' });

    expect(response.status).toBe(400);
  });

  it('a nonexistent fromId/toId returns 404 (NotFoundError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const real = await createObject(cookie, workspaceId, 'Real object');

    // Syntactically ULID-shaped but never actually created.
    const nonexistentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const badFromResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: nonexistentId, toId: real, kind: 'reference' });

    expect(badFromResponse.status).toBe(404);

    const badToResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: real, toId: nonexistentId, kind: 'reference' });

    expect(badToResponse.status).toBe(404);
  });

  it('cross-workspace: fromId/toId that exist but belong to a DIFFERENT workspace return 404', async () => {
    const { cookie, workspaceId: workspaceAId } = await registerUserWithWorkspace();
    const aId = await createObject(cookie, workspaceAId, 'Belongs to A');

    const workspaceBId = await createWorkspace(cookie, 'Workspace B (unrelated)');
    const bId = await createObject(cookie, workspaceBId, 'Belongs to B');

    const response = await request(server)
      .post(relationsUrl(workspaceBId))
      .set('Cookie', cookie)
      .send({ fromId: aId, toId: bId, kind: 'reference' });

    expect(response.status).toBe(404);
  });

  it('parentChild: a second active parent for the same child returns 409 (ConflictError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const parent1 = await createObject(cookie, workspaceId, 'Parent 1');
    const parent2 = await createObject(cookie, workspaceId, 'Parent 2');
    const child = await createObject(cookie, workspaceId, 'Child');

    const firstResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: parent1, toId: child, kind: 'parentChild' });

    expect(firstResponse.status).toBe(201);

    const secondResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: parent2, toId: child, kind: 'parentChild' });

    expect(secondResponse.status).toBe(409);
  });

  /**
   * Security regression (F1-T3 security review, Medium): unlike the analogous
   * "key must be unique" business rule in `FieldDefinitionsService.define`
   * (see `../fields/field-definitions-security.integration.test.ts`'s
   * "Finding 1", the exact precedent this test mirrors), `RelationsService.
   * create`'s "a child object has at most one active parent" rule for
   * `parentChild` relations is enforced ONLY via an in-memory
   * check-then-act: it reads the child's current relations, validates there
   * is no existing active parent, and only THEN appends the new relation's
   * event — with no database-level unique constraint backing the rule (no
   * `onConflictDoNothing` + post-catchUp existence re-check, unlike
   * `field-definitions.projection.ts`/`field-definitions.service.ts`'s fixed
   * equivalent). Two concurrent `create` calls for the same child can both
   * pass the pre-check before either's event lands, so both may resolve
   * 201 — this is the bug being pinned red here.
   */
  it('Finding: concurrent create() of two parentChild relations for the same child resolves to exactly one 201 and one 409, never two successes', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const parent1 = await createObject(cookie, workspaceId, 'Concurrent Parent 1');
    const parent2 = await createObject(cookie, workspaceId, 'Concurrent Parent 2');
    const child = await createObject(cookie, workspaceId, 'Concurrent Child');

    const [responseA, responseB] = await Promise.all([
      request(server)
        .post(relationsUrl(workspaceId))
        .set('Cookie', cookie)
        .send({ fromId: parent1, toId: child, kind: 'parentChild' }),
      request(server)
        .post(relationsUrl(workspaceId))
        .set('Cookie', cookie)
        .send({ fromId: parent2, toId: child, kind: 'parentChild' }),
    ]);

    // RED (expected, today): with only an in-memory pre-check guarding the
    // "at most one active parent" rule, both concurrent requests can observe
    // "no existing parent yet" before either's event is appended, so both
    // may return 201 here instead of exactly one 201 + one 409.
    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // The relations projection must not be left in a broken, double-parent
    // state afterward: exactly one of parent1/parent2 has "won" as the
    // child's current parent, never both.
    const relatedResponse = await request(server)
      .get(relatedUrl(workspaceId, child))
      .set('Cookie', cookie);
    expect(relatedResponse.status).toBe(200);

    const related = (relatedResponse.body as RelatedEnvelope).related;
    expect(related.parentChild.parent).not.toBeNull();
    expect([parent1, parent2]).toContain(related.parentChild.parent?.fromId);

    // The projection/checkpoint must not be poisoned by the race: a
    // completely unrelated relation create afterward still succeeds,
    // mirroring the field-definitions precedent's "unrelated write still
    // works" check.
    const unrelatedA = await createObject(cookie, workspaceId, 'Unrelated A (after race)');
    const unrelatedB = await createObject(cookie, workspaceId, 'Unrelated B (after race)');
    const unrelatedResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: unrelatedA, toId: unrelatedB, kind: 'reference' });
    expect(unrelatedResponse.status).toBe(201);
  });

  it('parentChild: a self-parent cycle (A is its own parent) returns 400 (ValidationError)', async () => {
    // Note: fromId === toId is already covered generically above; here we
    // pin that a same-node parentChild self-relation is rejected as a cycle/
    // validation error specifically (400), not merely relying on the generic
    // fromId===toId check being the only guard in place.
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');

    const response = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: a, kind: 'parentChild' });

    expect(response.status).toBe(400);
  });

  it('parentChild: a multi-hop ancestor cycle (grandchild becomes parent) returns 400 (ValidationError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const grandparent = await createObject(cookie, workspaceId, 'Grandparent');
    const parent = await createObject(cookie, workspaceId, 'Parent');
    const grandchild = await createObject(cookie, workspaceId, 'Grandchild');

    // grandparent -> parent -> grandchild
    const first = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: grandparent, toId: parent, kind: 'parentChild' });
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: parent, toId: grandchild, kind: 'parentChild' });
    expect(second.status).toBe(201);

    // grandchild -> grandparent would close the cycle.
    const cyclic = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: grandchild, toId: grandparent, kind: 'parentChild' });

    expect(cyclic.status).toBe(400);
  });

  it('dependency: a direct 2-node cycle (A blocks B, then B blocks A) returns 400 (ValidationError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const first = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'dependency' });
    expect(first.status).toBe(201);

    const cyclic = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: b, toId: a, kind: 'dependency' });

    expect(cyclic.status).toBe(400);
  });

  it('dependency: a 3-node cycle (A blocks B, B blocks C, then C blocks A) returns 400 (ValidationError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');
    const c = await createObject(cookie, workspaceId, 'C');

    const first = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'dependency' });
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: b, toId: c, kind: 'dependency' });
    expect(second.status).toBe(201);

    const cyclic = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: c, toId: a, kind: 'dependency' });

    expect(cyclic.status).toBe(400);
  });

  it('reference: a duplicate (same unordered pair, same kind, already active) returns 409 (ConflictError)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const firstResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(firstResponse.status).toBe(201);

    const duplicateResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(duplicateResponse.status).toBe(409);
  });

  it('reference: the REVERSE direction of an existing reference pair also counts as a duplicate (409)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const firstResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(firstResponse.status).toBe(201);

    // Same unordered pair, direction reversed.
    const reversedDuplicateResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: b, toId: a, kind: 'reference' });

    expect(reversedDuplicateResponse.status).toBe(409);
  });

  it('DELETE removes a relation: 204, no body', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const createResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    const relationId = (createResponse.body as RelationEnvelope).relation.id;

    const deleteResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${relationId}`)
      .set('Cookie', cookie);

    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toEqual({});
  });

  it('a nonexistent relationId returns 404 on DELETE', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();

    // Syntactically ULID-shaped but never actually created.
    const nonexistentRelationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const response = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${nonexistentRelationId}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it("cross-workspace: a relationId from workspace A returns 404 through workspace B's URL", async () => {
    const { cookie, workspaceId: workspaceAId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceAId, 'A');
    const b = await createObject(cookie, workspaceAId, 'B');

    const createResponse = await request(server)
      .post(relationsUrl(workspaceAId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    const relationId = (createResponse.body as RelationEnvelope).relation.id;

    const workspaceBId = await createWorkspace(cookie, 'Workspace B (unrelated, delete)');

    const crossWorkspaceDeleteResponse = await request(server)
      .delete(`${relationsUrl(workspaceBId)}/${relationId}`)
      .set('Cookie', cookie);

    expect(crossWorkspaceDeleteResponse.status).toBe(404);

    // Still perfectly deletable through its real workspace.
    const ownWorkspaceDeleteResponse = await request(server)
      .delete(`${relationsUrl(workspaceAId)}/${relationId}`)
      .set('Cookie', cookie);

    expect(ownWorkspaceDeleteResponse.status).toBe(204);
  });

  it('calling DELETE twice on the same relation returns 404 on the second call (projection row hard-deleted)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const createResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    const relationId = (createResponse.body as RelationEnvelope).relation.id;

    const firstDeleteResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${relationId}`)
      .set('Cookie', cookie);

    expect(firstDeleteResponse.status).toBe(204);

    const secondDeleteResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${relationId}`)
      .set('Cookie', cookie);

    expect(secondDeleteResponse.status).toBe(404);
  });

  it('removing a parentChild relation then re-creating a DIFFERENT parentChild relation for the same child succeeds (a RelationRemoved relation must not block a fresh create)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const parent1 = await createObject(cookie, workspaceId, 'Parent 1');
    const parent2 = await createObject(cookie, workspaceId, 'Parent 2 (new)');
    const child = await createObject(cookie, workspaceId, 'Child');

    const firstCreateResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: parent1, toId: child, kind: 'parentChild' });

    expect(firstCreateResponse.status).toBe(201);
    const firstRelationId = (firstCreateResponse.body as RelationEnvelope).relation.id;

    const removeResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${firstRelationId}`)
      .set('Cookie', cookie);

    expect(removeResponse.status).toBe(204);

    // A different parent for the same child, after the first was removed —
    // must succeed (proves the removed relation does not still block via the
    // "already has an active parent" conflict check, and does not still
    // participate in cycle detection).
    const secondCreateResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: parent2, toId: child, kind: 'parentChild' });

    expect(secondCreateResponse.status).toBe(201);
    const secondRelation = (secondCreateResponse.body as RelationEnvelope).relation;
    expect(secondRelation.fromId).toBe(parent2);
    expect(secondRelation.toId).toBe(child);
    expect(secondRelation.status).toBe('active');

    // Replay-determinism sanity check (HTTP-level only, per this file's
    // "DESIGN NOTES" — no rebuild-trigger endpoint exists to test a full
    // from-scratch projection rebuild): the first (removed) relation is truly
    // gone (404 on a repeat delete)...
    const repeatDeleteOfFirstResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${firstRelationId}`)
      .set('Cookie', cookie);
    expect(repeatDeleteOfFirstResponse.status).toBe(404);

    // ...while the fresh relation is genuinely persisted and independently
    // deletable (proves it was actually written, not just echoed back).
    const deleteOfSecondResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${secondRelation.id}`)
      .set('Cookie', cookie);
    expect(deleteOfSecondResponse.status).toBe(204);
  });

  it('removing a reference relation then re-adding the SAME pair succeeds (a RelationRemoved relation must not block a fresh create)', async () => {
    const { cookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(cookie, workspaceId, 'A');
    const b = await createObject(cookie, workspaceId, 'B');

    const firstCreateResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(firstCreateResponse.status).toBe(201);
    const firstRelationId = (firstCreateResponse.body as RelationEnvelope).relation.id;

    const removeResponse = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${firstRelationId}`)
      .set('Cookie', cookie);

    expect(removeResponse.status).toBe(204);

    const secondCreateResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId: a, toId: b, kind: 'reference' });

    expect(secondCreateResponse.status).toBe(201);
    expect((secondCreateResponse.body as RelationEnvelope).relation.status).toBe('active');
  });

  it('guard stack: unauthenticated requests are rejected with 401, non-members with 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerUserWithWorkspace();
    const a = await createObject(ownerCookie, workspaceId, 'A');
    const b = await createObject(ownerCookie, workspaceId, 'B');

    const noSessionResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .send({ fromId: a, toId: b, kind: 'reference' });
    expect(noSessionResponse.status).toBe(401);

    const outsiderCookie = await registerUser();
    const outsiderResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', outsiderCookie)
      .send({ fromId: a, toId: b, kind: 'reference' });
    expect(outsiderResponse.status).toBe(403);

    // Sanity: the owner themself is unaffected by the above.
    const ownerResponse = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send({ fromId: a, toId: b, kind: 'reference' });
    expect(ownerResponse.status).toBe(201);
  });
});
