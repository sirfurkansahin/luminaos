import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RelationsViewProjection } from './relations.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { relationsView } from '../db/schema/relations-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T3 PR-C: real, end-to-end integration test for the two remaining
 * acceptance criteria this task adds on top of PR-A (pure domain) and PR-B
 * (create/remove HTTP CRUD, already green):
 *
 *   1. `GET /workspaces/:workspaceId/relations/object/:objectId` —
 *      `getRelated`, grouped by kind, with soft-delete/restore interaction
 *      (spec §3: "nesne soft-delete olunca ilişkileri askıya alınır
 *      (projeksiyonda süzülür), restore'da geri gelir").
 *   2. A replay-determinism proof for `RelationsViewProjection`: a full
 *      `ProjectionRunner.rebuild()` reproduces byte-for-byte the same
 *      `relations_view` row set that incremental, HTTP-driven catch-up
 *      already produced.
 *
 * Mirrors `./relations.integration.test.ts`'s exact Testcontainers/supertest
 * skeleton (this file does NOT import from that file — every integration
 * test file in this repo is self-contained, per `../fields/field-definitions.
 * integration.test.ts` and `../objects/objects.integration.test.ts`'s own
 * independent helper duplication — helpers below are redeclared, not
 * shared). This file does NOT modify `relations.integration.test.ts` (PR-B's
 * file, already green and out of scope here).
 *
 * ============================================================================
 * RED STATE (expected, today): `RelationsController`
 * (`./relations.controller.ts`) only exposes `POST /workspaces/:workspaceId/
 * relations` and `DELETE /workspaces/:workspaceId/relations/:relationId`
 * (PR-B). There is no `GET /workspaces/:workspaceId/relations/object/
 * :objectId` route yet, and no `RelationsService.getRelated(...)` method
 * backing it. Every `GET .../relations/object/:objectId` request below is
 * therefore expected to 404 via Nest's own default "Cannot GET ..." handler
 * (there is no matching route at all — Nest's router falls through past
 * `@Delete(':relationId')`, which does not match a `/object/:objectId`
 * sub-path, to its default not-found handler), NOT via `AppErrorFilter`
 * mapping a `NotFoundError` — assertions below will fail with e.g. "expected
 * 404 to be 200" and the body will be Nest's default `{"message":"Cannot GET
 * /workspaces/.../relations/object/...","error":"Not Found","statusCode":
 * 404}` shape rather than `{ related: {...} }`. That is the correct red: it
 * means the ROUTE doesn't exist yet, not that this test file's own logic is
 * wrong. `implementer` must add `RelationsController.getRelated` +
 * `RelationsService.getRelated` to turn the grouping/soft-delete tests green.
 *
 * The replay-determinism describe block at the bottom of this file does NOT
 * depend on the new route at all (it drives fixture creation entirely
 * through the ALREADY-GREEN `POST`/`DELETE` routes, then proves determinism
 * via a raw, off-HTTP `ProjectionRunner.rebuild(...)` call) — it is expected
 * to be GREEN already, today, against PR-B's existing implementation; it is
 * included here (rather than in `relations.integration.test.ts`) only
 * because this task's scope groups it alongside `getRelated` per the plan.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `GET /workspaces/:workspaceId/relations/object/:objectId` on the EXISTING
 * `RelationsController` (same guard stack: `SessionAuthGuard` +
 * `WorkspaceMembershipGuard`, no admin gating — mirrors every other route on
 * this controller). Response, 200:
 *
 *   { related: {
 *       parentChild: { parent: Relation | null, children: Relation[], childrenCount: number },
 *       dependency:  { blocks: Relation[], blockedBy: Relation[] },
 *       reference:   Relation[],
 *   } }
 *
 * Direction conventions (fixed by PR-A, re-pinned here):
 *   - parentChild: `fromId` = parent, `toId` = child.
 *   - dependency: `fromId` blocks `toId`.
 *   - reference: direction-agnostic (symmetric) — a single reference relation
 *     appears in BOTH endpoints' `reference` arrays, regardless of which side
 *     is `fromId`/`toId`.
 *
 * Every `Relation` returned here is implicitly `status: 'active'` (removed
 * relations are hard-deleted from `relations_view`, per PR-B/`
 * RelationsViewProjection` — there is no "removed but visible" row to filter
 * out at this layer).
 *
 * SOFT-DELETE / RESTORE INTERACTION (this task's core new behavior): a
 * relation whose COUNTERPART object (the other end, not the object being
 * queried) currently has `lifecycle: 'deleted'` (soft-deleted via `DELETE
 * /workspaces/:workspaceId/objects/:objectId`) is SUSPENDED — filtered out of
 * every group it would otherwise appear in — without the underlying relation
 * row itself being touched. Restoring that counterpart object (`POST
 * .../objects/:objectId/restore`) makes the relation reappear, unchanged.
 * This filtering is asymmetric: soft-deleting the object BEING QUERIED (not
 * its counterpart) does NOT itself suspend anything and does NOT 404 —
 * `getRelated`, like `ObjectsService.get`, does not filter by the queried
 * object's own lifecycle (only `ObjectsService.list` does); only a
 * counterpart's lifecycle matters for suspension.
 *
 * `objectId` not found in this workspace (never created, or belonging to a
 * different workspace) -> 404. An object that exists but has zero relations
 * -> 200 with every group empty (`parent: null, children: [], childrenCount:
 * 0, blocks: [], blockedBy: [], reference: []`), NOT a 404.
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

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim, per this task's instructions,
 * and per `relations.integration.test.ts`'s own copy of it). */
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
  return `relations-related-test-user-${String(emailCounter)}@example.com`;
}

/** Sorted list of relation ids — used for order-independent set-equality
 * assertions on grouped relation arrays. */
function relationIds(relations: RelationBody[]): string[] {
  return relations.map((relation) => relation.id).sort();
}

describe('Relations — getRelated + replay determinism (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;

  /** A raw Drizzle client, separate pool, same connection string as the
   * Nest-wired app — used only by the replay-determinism block below to read
   * `relations_view` directly and to drive an off-HTTP `ProjectionRunner.
   * rebuild(...)`, mirroring `../event-store/projections/
   * projection-rebuild.integration.test.ts`'s exact pattern. */
  let rawDb: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per
    // `relations.integration.test.ts`'s established convention.
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

  function relatedUrl(workspaceId: string, objectId: string): string {
    return `/workspaces/${workspaceId}/relations/object/${objectId}`;
  }

  /** Creates a relation via the already-green `POST` route and returns its
   * body — a thin wrapper used throughout as fixture setup. */
  async function createRelation(
    cookie: string,
    workspaceId: string,
    fromId: string,
    toId: string,
    kind: RelationKindBody,
  ): Promise<RelationBody> {
    const response = await request(server)
      .post(relationsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ fromId, toId, kind });

    expect(response.status).toBe(201);
    return (response.body as RelationEnvelope).relation;
  }

  /** Removes a relation via the already-green `DELETE` route. */
  async function removeRelation(
    cookie: string,
    workspaceId: string,
    relationId: string,
  ): Promise<void> {
    const response = await request(server)
      .delete(`${relationsUrl(workspaceId)}/${relationId}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(204);
  }

  /** Soft-deletes an object via `DELETE /workspaces/:workspaceId/objects/
   * :objectId` (204, no body). */
  async function softDeleteObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<void> {
    const response = await request(server)
      .delete(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(204);
  }

  /** Restores a soft-deleted object via `POST /workspaces/:workspaceId/
   * objects/:objectId/restore` (200). */
  async function restoreObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<void> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/restore`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
  }

  async function getRelated(cookie: string, workspaceId: string, objectId: string) {
    return request(server).get(relatedUrl(workspaceId, objectId)).set('Cookie', cookie);
  }

  describe('grouping correctness', () => {
    it('parentChild: the parent object sees BOTH children grouped under `children`, with `parent: null` and correct `childrenCount`', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const parent = await createObject(cookie, workspaceId, 'Parent');
      const child1 = await createObject(cookie, workspaceId, 'Child 1');
      const child2 = await createObject(cookie, workspaceId, 'Child 2');

      const relation1 = await createRelation(cookie, workspaceId, parent, child1, 'parentChild');
      const relation2 = await createRelation(cookie, workspaceId, parent, child2, 'parentChild');

      const response = await getRelated(cookie, workspaceId, parent);
      expect(response.status).toBe(200);

      const { related } = response.body as RelatedEnvelope;
      expect(related.parentChild.parent).toBeNull();
      expect(related.parentChild.childrenCount).toBe(2);
      expect(relationIds(related.parentChild.children)).toEqual(
        relationIds([relation1, relation2]),
      );
    });

    it('parentChild: a child object sees its single `parent` relation (non-null) and an empty `children` group', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const parent = await createObject(cookie, workspaceId, 'Parent');
      const child1 = await createObject(cookie, workspaceId, 'Child 1');
      await createObject(cookie, workspaceId, 'Child 2 (unrelated to child1)');

      const parentRelation = await createRelation(
        cookie,
        workspaceId,
        parent,
        child1,
        'parentChild',
      );

      const response = await getRelated(cookie, workspaceId, child1);
      expect(response.status).toBe(200);

      const { related } = response.body as RelatedEnvelope;
      expect(related.parentChild.parent).not.toBeNull();
      expect(related.parentChild.parent?.id).toBe(parentRelation.id);
      expect(related.parentChild.parent?.fromId).toBe(parent);
      expect(related.parentChild.parent?.toId).toBe(child1);
      expect(related.parentChild.children).toEqual([]);
      expect(related.parentChild.childrenCount).toBe(0);
    });

    it('dependency: the blocking object sees the relation under `blocks`, the blocked object sees it under `blockedBy`', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const a = await createObject(cookie, workspaceId, 'A');
      const b = await createObject(cookie, workspaceId, 'B');

      const relation = await createRelation(cookie, workspaceId, a, b, 'dependency');

      const responseForA = await getRelated(cookie, workspaceId, a);
      expect(responseForA.status).toBe(200);
      const relatedForA = (responseForA.body as RelatedEnvelope).related;
      expect(relationIds(relatedForA.dependency.blocks)).toEqual([relation.id]);
      expect(relatedForA.dependency.blockedBy).toEqual([]);

      const responseForB = await getRelated(cookie, workspaceId, b);
      expect(responseForB.status).toBe(200);
      const relatedForB = (responseForB.body as RelatedEnvelope).related;
      expect(relationIds(relatedForB.dependency.blockedBy)).toEqual([relation.id]);
      expect(relatedForB.dependency.blocks).toEqual([]);
    });

    it("reference: is direction-agnostic — the SAME relation appears in BOTH endpoints' `reference` array regardless of fromId/toId side", async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const x = await createObject(cookie, workspaceId, 'X');
      const y = await createObject(cookie, workspaceId, 'Y');

      const relation = await createRelation(cookie, workspaceId, x, y, 'reference');

      const responseForX = await getRelated(cookie, workspaceId, x);
      expect(responseForX.status).toBe(200);
      expect(relationIds((responseForX.body as RelatedEnvelope).related.reference)).toEqual([
        relation.id,
      ]);

      const responseForY = await getRelated(cookie, workspaceId, y);
      expect(responseForY.status).toBe(200);
      expect(relationIds((responseForY.body as RelatedEnvelope).related.reference)).toEqual([
        relation.id,
      ]);
    });

    it('an object with NO relations at all returns 200 with every group empty (not a 404)', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const lonely = await createObject(cookie, workspaceId, 'Lonely object');

      const response = await getRelated(cookie, workspaceId, lonely);
      expect(response.status).toBe(200);

      const { related } = response.body as RelatedEnvelope;
      expect(related.parentChild.parent).toBeNull();
      expect(related.parentChild.children).toEqual([]);
      expect(related.parentChild.childrenCount).toBe(0);
      expect(related.dependency.blocks).toEqual([]);
      expect(related.dependency.blockedBy).toEqual([]);
      expect(related.reference).toEqual([]);
    });

    it('a nonexistent objectId returns 404', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();

      // Syntactically ULID-shaped but never actually created.
      const nonexistentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

      const response = await getRelated(cookie, workspaceId, nonexistentId);
      expect(response.status).toBe(404);
    });

    it('an objectId that exists but belongs to a DIFFERENT workspace than the URL returns 404', async () => {
      const { cookie, workspaceId: workspaceAId } = await registerUserWithWorkspace();
      const objectInA = await createObject(cookie, workspaceAId, 'Belongs to A');

      const workspaceBId = await createWorkspace(cookie, 'Workspace B (unrelated)');

      const response = await getRelated(cookie, workspaceBId, objectInA);
      expect(response.status).toBe(404);
    });
  });

  describe('soft-delete / restore interaction (spec §3)', () => {
    it("parentChild: soft-deleting the CHILD suspends it out of the parent's `children` group; restoring brings it back", async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const parent = await createObject(cookie, workspaceId, 'Parent');
      const child = await createObject(cookie, workspaceId, 'Child');

      const relation = await createRelation(cookie, workspaceId, parent, child, 'parentChild');

      await softDeleteObject(cookie, workspaceId, child);

      const suspendedResponse = await getRelated(cookie, workspaceId, parent);
      expect(suspendedResponse.status).toBe(200);
      const suspendedRelated = (suspendedResponse.body as RelatedEnvelope).related;
      expect(suspendedRelated.parentChild.children).toEqual([]);
      expect(suspendedRelated.parentChild.childrenCount).toBe(0);

      await restoreObject(cookie, workspaceId, child);

      const restoredResponse = await getRelated(cookie, workspaceId, parent);
      expect(restoredResponse.status).toBe(200);
      const restoredRelated = (restoredResponse.body as RelatedEnvelope).related;
      expect(relationIds(restoredRelated.parentChild.children)).toEqual([relation.id]);
      expect(restoredRelated.parentChild.childrenCount).toBe(1);
    });

    it("reference: soft-deleting one side suspends the relation out of the OTHER side's `reference` array; restoring brings it back (proves filtering is not parentChild-specific)", async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const x = await createObject(cookie, workspaceId, 'X');
      const y = await createObject(cookie, workspaceId, 'Y');

      const relation = await createRelation(cookie, workspaceId, x, y, 'reference');

      await softDeleteObject(cookie, workspaceId, y);

      const suspendedResponse = await getRelated(cookie, workspaceId, x);
      expect(suspendedResponse.status).toBe(200);
      expect((suspendedResponse.body as RelatedEnvelope).related.reference).toEqual([]);

      await restoreObject(cookie, workspaceId, y);

      const restoredResponse = await getRelated(cookie, workspaceId, x);
      expect(restoredResponse.status).toBe(200);
      expect(relationIds((restoredResponse.body as RelatedEnvelope).related.reference)).toEqual([
        relation.id,
      ]);
    });

    it("soft-deleting the QUERIED object itself does NOT 404 and does NOT suspend its own still-active relations (only a counterpart's lifecycle matters)", async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const parent = await createObject(
        cookie,
        workspaceId,
        'Parent (will be soft-deleted itself)',
      );
      const child = await createObject(cookie, workspaceId, 'Child (stays active)');

      const relation = await createRelation(cookie, workspaceId, parent, child, 'parentChild');

      await softDeleteObject(cookie, workspaceId, parent);

      const response = await getRelated(cookie, workspaceId, parent);
      expect(response.status).toBe(200);

      const { related } = response.body as RelatedEnvelope;
      expect(relationIds(related.parentChild.children)).toEqual([relation.id]);
      expect(related.parentChild.childrenCount).toBe(1);
    });
  });

  describe('replay determinism (raw, off-HTTP `ProjectionRunner.rebuild`)', () => {
    /**
     * DESIGN NOTE: unlike every other block in this file, the rebuild step
     * itself necessarily goes around HTTP by design — there is no HTTP
     * endpoint that triggers a projection rebuild. Fixture creation and the
     * "before" snapshot are still taken entirely through real HTTP
     * (`POST`/`DELETE` on `RelationsController`), per this file's own
     * constraint; only the rebuild trigger and the raw-row reads bypass it,
     * mirroring `../event-store/projections/projection-rebuild.
     * integration.test.ts`'s established pattern exactly (raw `Database` +
     * `EventStoreService` + `ProjectionRunner` constructed directly, off the
     * SAME Postgres connection string the HTTP-facing app itself uses).
     */
    it('a full rebuild reproduces the exact same `relations_view` row set (ids, fromId/toId/kind) that HTTP-driven incremental catch-up already produced, including a correctly-absent removed relation', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const parent = await createObject(cookie, workspaceId, 'Replay Parent');
      const child1 = await createObject(cookie, workspaceId, 'Replay Child 1');
      const child2 = await createObject(cookie, workspaceId, 'Replay Child 2 (relation removed)');
      const blocker = await createObject(cookie, workspaceId, 'Replay Blocker');
      const blocked = await createObject(cookie, workspaceId, 'Replay Blocked');
      const refX = await createObject(cookie, workspaceId, 'Replay RefX');
      const refY = await createObject(cookie, workspaceId, 'Replay RefY');

      const kept1 = await createRelation(cookie, workspaceId, parent, child1, 'parentChild');
      const removed = await createRelation(cookie, workspaceId, parent, child2, 'parentChild');
      const kept2 = await createRelation(cookie, workspaceId, blocker, blocked, 'dependency');
      const kept3 = await createRelation(cookie, workspaceId, refX, refY, 'reference');

      // Mixed final state: some relations created-and-kept, one
      // created-then-removed.
      await removeRelation(cookie, workspaceId, removed.id);

      async function readWorkspaceRelationRows(): Promise<
        { id: string; fromId: string; toId: string; kind: string }[]
      > {
        const rows = await rawDb
          .select({
            id: relationsView.id,
            fromId: relationsView.fromId,
            toId: relationsView.toId,
            kind: relationsView.kind,
          })
          .from(relationsView)
          .where(eq(relationsView.workspaceId, workspaceId));

        return rows.sort((a, b) => a.id.localeCompare(b.id));
      }

      const beforeRebuild = await readWorkspaceRelationRows();

      // Sanity: the removed relation is genuinely absent, and exactly the 3
      // kept relations are present, BEFORE we even touch the projection —
      // otherwise the rebuild comparison below would be vacuous.
      expect(relationIds(beforeRebuild as unknown as RelationBody[])).toEqual(
        relationIds([kept1, kept2, kept3]),
      );
      expect(beforeRebuild.some((row) => row.id === removed.id)).toBe(false);

      const eventStore = new EventStoreService(rawDb);
      const projectionRunner = new ProjectionRunner(rawDb, eventStore);
      const relationsProjection = new RelationsViewProjection();

      await projectionRunner.rebuild(relationsProjection);

      const afterRebuild = await readWorkspaceRelationRows();

      expect(afterRebuild).toEqual(beforeRebuild);
      expect(afterRebuild.some((row) => row.id === removed.id)).toBe(false);
    });
  });
});
