import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T2 (RED step, endpoint half). Pins `GET
 * /workspaces/:workspaceId/context/:objectId` (`ContextController`/
 * `ContextService`/`ContextModule`, `apps/server/src/context/`), per
 * ADR-0018:
 *
 *  - Karar (b): field-level-only RBAC on the ROOT entity's `fieldValues`
 *    (mirrors `ObjectsService.filterFieldValuesForRole`); neighbor `entity`
 *    node summaries carry `entityId`/`objectType`/`title` but NEVER
 *    `fieldValues`.
 *  - Karar (c) -- CRITICAL: the root entity's OWN `entity-topic` edges are
 *    ALSO filtered by `sourceFieldKey`'s hidden-ness -- a hidden field's
 *    topic edge must be entirely absent from `edges`, not just from
 *    `fieldValues`.
 *  - Karar (d): response shape `{ asOf, entity: {entityId, objectType,
 *    title, fieldValues}, edges: [{edgeType, direction, node, sourceFieldKey?,
 *    sourceRelationId?}] }`; 404 (`NotFoundError`) for a missing or
 *    cross-workspace `objectId`.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *  - `context/context.controller.ts` (new) -- `@Controller
 *    ('workspaces/:workspaceId/context')`, `@UseGuards(SessionAuthGuard,
 *    WorkspaceMembershipGuard)`, `GET /workspaces/:workspaceId/context/
 *    :objectId`, a `requireRole(req)` copy of `ExportController`'s (fails
 *    closed 403 if the guard somehow didn't run).
 *  - `context/context.service.ts` (new) -- `ContextService.getContext
 *    (workspaceId, objectId, callerRole)`: resolves the entity node by
 *    `naturalKey = objectId`, gathers every edge touching it (either
 *    direction), resolves neighbor node summaries, filters the ROOT
 *    entity's `fieldValues` AND its own `entity-topic` edges by
 *    `sourceFieldKey` hidden-ness, and reads `asOf` from
 *    `projection_checkpoints.updatedAt` (`projectionName='context-graph'`).
 *  - `context/context.module.ts` (new) wires the above into `AppModule`.
 *  - `context/context-graph-sync.worker.ts` (new, sibling PR/task; this
 *    file drives it directly via `syncOnce()`, never waiting on its real
 *    5-second interval) -- see `context-graph-sync.worker.integration.
 *    test.ts` for its own pinned contract.
 *
 * `direction` is `'outgoing'` when the root entity is `fromNodeId`,
 * `'incoming'` when it is `toNodeId` (only `entity-entity` edges can be
 * either way in this task's data; every other edge type is always
 * `'outgoing'` from the entity's own perspective per `context-graph.
 * projection.ts`).
 *
 * ----------------------------------------------------------------------------
 * KNOWN OPEN TENSION (flag for implementer/security-reviewer, not this
 * file's to resolve): ADR-0018's bullet 3 claims `ProjectionRunner.
 * writeCheckpoint` runs "at the end of every catchUp call, even an empty
 * batch". Reading `projection-runner.service.ts`'s actual `catchUp` loop
 * today, an EMPTY first batch returns immediately WITHOUT calling
 * `writeCheckpoint` -- so `updatedAt` does NOT advance on a no-op sync. Test
 * 2 below ("asOf advances") is deliberately written to never depend on that
 * edge case: it always has a genuine new event between the two `syncOnce()`
 * calls it compares, so `writeCheckpoint` is guaranteed to run either way.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface ObjectBody {
  id: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface FieldDefinitionBody {
  id: string;
  key: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface RelationEnvelope {
  relation: { id: string };
}

interface ContextNodeSummary {
  nodeType: string;
  naturalKey: string;
  entityId?: string;
  objectType?: string;
  title?: string;
  fieldValues?: Record<string, unknown>;
}

interface ContextEdge {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  node: ContextNodeSummary;
  sourceFieldKey?: string | null;
  sourceRelationId?: string | null;
}

interface ContextResponseBody {
  asOf: string;
  entity: {
    entityId: string;
    objectType: string;
    title: string;
    fieldValues: Record<string, unknown>;
  };
  edges: ContextEdge[];
}

const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `context-api-test-user-${String(emailCounter)}@example.com`;
}

/**
 * `context-graph-sync.worker.ts` doesn't exist yet -- same `*Like`/
 * `*Constructor` escape hatch as `context-graph-sync.worker.integration.
 * test.ts` (and `calendar-sync-poller.integration.test.ts` before it), so
 * this file can drive a real sync without a `type`-only import cascading
 * `any`-related lint errors beyond the one genuinely-expected
 * `import-x/no-unresolved`.
 */
interface ContextGraphSyncWorkerLike {
  syncOnce(): Promise<void>;
}

interface ContextGraphSyncWorkerConstructor {
  new (...args: unknown[]): ContextGraphSyncWorkerLike;
}

describe('F2-T2 (RED step): GET /workspaces/:workspaceId/context/:objectId (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let ContextGraphSyncWorker: ContextGraphSyncWorkerConstructor;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const workerModule = (await import('./context-graph-sync.worker.js')) as unknown as {
      ContextGraphSyncWorker: ContextGraphSyncWorkerConstructor;
    };
    ContextGraphSyncWorker = workerModule.ContextGraphSyncWorker;

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

  async function syncOnce(): Promise<void> {
    const worker = app.get(ContextGraphSyncWorker);
    await worker.syncOnce();
  }

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

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Context API test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function objectsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects`;
  }

  function fieldsUrl(workspaceId: string, objectType: string): string {
    return `/workspaces/${workspaceId}/object-types/${objectType}/fields`;
  }

  function contextUrl(workspaceId: string, objectId: string): string {
    return `/workspaces/${workspaceId}/context/${objectId}`;
  }

  async function createObject(
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

  async function defineField(
    cookie: string,
    workspaceId: string,
    body: {
      key: string;
      label: string;
      fieldType: string;
      config: unknown;
      permissions: FieldPermissionsBody;
    },
  ): Promise<FieldDefinitionBody> {
    const response = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send(body);
    expect(response.status).toBe(201);
    return (response.body as FieldDefinitionEnvelope).fieldDefinition;
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

  async function createRelation(
    cookie: string,
    workspaceId: string,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/relations`)
      .set('Cookie', cookie)
      .send({ fromId, toId, kind: 'reference' });
    expect(response.status).toBe(201);
    expect((response.body as RelationEnvelope).relation.id).toBeDefined();
  }

  function getContext(cookie: string, workspaceId: string, objectId: string): request.Test {
    return request(server).get(contextUrl(workspaceId, objectId)).set('Cookie', cookie);
  }

  it('1. returns the root entity + all 4 edge types (entity-entity, entity-person, entity-time, entity-topic type-based AND field-based)', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();

    const root = await createObject(cookie, workspaceId, 'Root object');
    const neighbor = await createObject(cookie, workspaceId, 'Related object');
    await createRelation(cookie, workspaceId, root.id, neighbor.id);

    await defineField(cookie, workspaceId, {
      key: 'severity',
      label: 'Severity',
      fieldType: 'select',
      config: {
        options: [
          { value: 'bug', label: 'Bug' },
          { value: 'feature', label: 'Feature' },
        ],
      },
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await setFieldValues(cookie, workspaceId, root.id, { severity: 'bug' });

    await syncOnce();

    const response = await getContext(cookie, workspaceId, root.id);
    expect(response.status).toBe(200);
    const body = response.body as ContextResponseBody;

    expect(body.entity.entityId).toBe(root.id);
    expect(body.entity.objectType).toBe('task');
    expect(body.entity.title).toBe('Root object');
    expect(body.entity.fieldValues['severity']).toBe('bug');

    // entity-entity: created by the RelationCreated above, root -> neighbor.
    const entityEntityEdge = body.edges.find(
      (edge) => edge.edgeType === 'entity-entity' && edge.node.entityId === neighbor.id,
    );
    expect(entityEntityEdge).toBeDefined();
    expect(entityEntityEdge?.direction).toBe('outgoing');
    expect(entityEntityEdge?.sourceRelationId).toBeDefined();

    // entity-person: from ObjectCreated's user actor.
    const entityPersonEdge = body.edges.find(
      (edge) => edge.edgeType === 'entity-person' && edge.node.naturalKey === userId,
    );
    expect(entityPersonEdge).toBeDefined();
    expect(entityPersonEdge?.node.nodeType).toBe('person');

    // entity-time: day-bucket node from ObjectCreated.
    const entityTimeEdge = body.edges.find((edge) => edge.edgeType === 'entity-time');
    expect(entityTimeEdge).toBeDefined();
    expect(entityTimeEdge?.node.nodeType).toBe('time');

    // entity-topic, type-based (sourceFieldKey null, naturalKey='task').
    const typeTopicEdge = body.edges.find(
      (edge) =>
        edge.edgeType === 'entity-topic' &&
        edge.sourceFieldKey == null &&
        edge.node.naturalKey === 'task',
    );
    expect(typeTopicEdge).toBeDefined();

    // entity-topic, field-based (sourceFieldKey='severity', naturalKey='bug').
    const fieldTopicEdge = body.edges.find(
      (edge) =>
        edge.edgeType === 'entity-topic' &&
        edge.sourceFieldKey === 'severity' &&
        edge.node.naturalKey === 'bug',
    );
    expect(fieldTopicEdge).toBeDefined();
  });

  it('2. asOf is an ISO8601 timestamp that advances after a subsequent syncOnce() picks up a genuinely new event', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const root = await createObject(cookie, workspaceId, 'AsOf root');

    await syncOnce();
    const firstResponse = await getContext(cookie, workspaceId, root.id);
    expect(firstResponse.status).toBe(200);
    const firstBody = firstResponse.body as ContextResponseBody;
    expect(new Date(firstBody.asOf).toString()).not.toBe('Invalid Date');

    // A genuinely new event in between guarantees `writeCheckpoint` runs
    // (see this file's header "KNOWN OPEN TENSION" note).
    await createObject(cookie, workspaceId, 'AsOf second object');
    await syncOnce();

    const secondResponse = await getContext(cookie, workspaceId, root.id);
    expect(secondResponse.status).toBe(200);
    const secondBody = secondResponse.body as ContextResponseBody;
    expect(new Date(secondBody.asOf).toString()).not.toBe('Invalid Date');

    expect(new Date(secondBody.asOf).getTime()).toBeGreaterThan(new Date(firstBody.asOf).getTime());
  });

  it('3. field-level RBAC: a "hidden" field is filtered per-role (owner/admin/member see it, guest does not); neighbor entity summaries never carry fieldValues at all', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const adminCookie = await addMemberWithRole(workspaceId, 'admin');
    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, {
      key: 'secret-note',
      label: 'Secret Note',
      fieldType: 'text',
      config: {},
      permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'hidden' },
    });
    await defineField(ownerCookie, workspaceId, {
      key: 'visible-note',
      label: 'Visible Note',
      fieldType: 'text',
      config: {},
      permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'view' },
    });

    const root = await createObject(ownerCookie, workspaceId, 'RBAC root');
    const neighbor = await createObject(ownerCookie, workspaceId, 'RBAC neighbor');
    await createRelation(ownerCookie, workspaceId, root.id, neighbor.id);
    await setFieldValues(ownerCookie, workspaceId, root.id, {
      'secret-note': 'shh',
      'visible-note': 'ok',
    });

    await syncOnce();

    const guestResponse = await getContext(guestCookie, workspaceId, root.id);
    expect(guestResponse.status).toBe(200);
    const guestBody = guestResponse.body as ContextResponseBody;
    expect(guestBody.entity.fieldValues).not.toHaveProperty('secret-note');
    expect(guestBody.entity.fieldValues['visible-note']).toBe('ok');

    const ownerResponse = await getContext(ownerCookie, workspaceId, root.id);
    expect(ownerResponse.status).toBe(200);
    const ownerBody = ownerResponse.body as ContextResponseBody;
    expect(ownerBody.entity.fieldValues['secret-note']).toBe('shh');

    // "admin" has 'edit' on secret-note -> visible.
    const adminResponse = await getContext(adminCookie, workspaceId, root.id);
    expect(adminResponse.status).toBe(200);
    const adminBody = adminResponse.body as ContextResponseBody;
    expect(adminBody.entity.fieldValues['secret-note']).toBe('shh');

    // "member" has 'view' (not 'hidden') on secret-note -> also visible,
    // proving the filter is genuinely permission-based ('hidden' only),
    // not a coarse owner/admin-vs-everyone-else check.
    const memberResponse = await getContext(memberCookie, workspaceId, root.id);
    expect(memberResponse.status).toBe(200);
    const memberBody = memberResponse.body as ContextResponseBody;
    expect(memberBody.entity.fieldValues['secret-note']).toBe('shh');

    // Neighbor entity summaries never carry fieldValues, for ANY role.
    for (const body of [guestBody, ownerBody, adminBody, memberBody]) {
      const neighborEdge = body.edges.find(
        (edge) => edge.edgeType === 'entity-entity' && edge.node.entityId === neighbor.id,
      );
      expect(neighborEdge).toBeDefined();
      expect(neighborEdge?.node.fieldValues).toBeUndefined();
    }
  });

  it("4. CRITICAL (ADR-0018 Karar c): a hidden field's entity-topic edge is fully absent for guest, but a non-hidden field's entity-topic edge remains -- and the hidden one IS visible for owner", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, {
      key: 'severity',
      label: 'Severity',
      fieldType: 'select',
      config: {
        options: [
          { value: 'bug', label: 'Bug' },
          { value: 'feature', label: 'Feature' },
        ],
      },
      permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'hidden' },
    });
    await defineField(ownerCookie, workspaceId, {
      key: 'category',
      label: 'Category',
      fieldType: 'select',
      config: {
        options: [
          { value: 'x', label: 'X' },
          { value: 'y', label: 'Y' },
        ],
      },
      permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'view' },
    });

    const root = await createObject(ownerCookie, workspaceId, 'Leak-check root');
    await setFieldValues(ownerCookie, workspaceId, root.id, { severity: 'bug', category: 'x' });

    await syncOnce();

    const guestResponse = await getContext(guestCookie, workspaceId, root.id);
    expect(guestResponse.status).toBe(200);
    const guestBody = guestResponse.body as ContextResponseBody;

    const guestStatusEdges = guestBody.edges.filter(
      (edge) => edge.edgeType === 'entity-topic' && edge.sourceFieldKey === 'severity',
    );
    expect(guestStatusEdges).toHaveLength(0);

    const guestCategoryEdge = guestBody.edges.find(
      (edge) =>
        edge.edgeType === 'entity-topic' &&
        edge.sourceFieldKey === 'category' &&
        edge.node.naturalKey === 'x',
    );
    expect(guestCategoryEdge).toBeDefined();

    const guestTypeTopicEdge = guestBody.edges.find(
      (edge) =>
        edge.edgeType === 'entity-topic' &&
        edge.sourceFieldKey == null &&
        edge.node.naturalKey === 'task',
    );
    expect(guestTypeTopicEdge).toBeDefined();

    // The SAME field, queried as owner, IS visible -- proving the guest
    // absence above is a role-based filter, not a projection bug.
    const ownerResponse = await getContext(ownerCookie, workspaceId, root.id);
    expect(ownerResponse.status).toBe(200);
    const ownerBody = ownerResponse.body as ContextResponseBody;
    const ownerStatusEdge = ownerBody.edges.find(
      (edge) =>
        edge.edgeType === 'entity-topic' &&
        edge.sourceFieldKey === 'severity' &&
        edge.node.naturalKey === 'bug',
    );
    expect(ownerStatusEdge).toBeDefined();
  });

  it('5. a non-existent objectId 404s, and an objectId belonging to a DIFFERENT workspace also 404s (no cross-workspace existence leak)', async () => {
    const { cookie: cookieA, workspaceId: workspaceIdA } = await registerOwnerWithWorkspace();
    const { cookie: cookieB, workspaceId: workspaceIdB } = await registerOwnerWithWorkspace();
    const objectInB = await createObject(cookieB, workspaceIdB, 'Belongs to B');
    await syncOnce();

    const missingResponse = await getContext(cookieA, workspaceIdA, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(missingResponse.status).toBe(404);

    const crossWorkspaceResponse = await getContext(cookieA, workspaceIdA, objectInB.id);
    expect(crossWorkspaceResponse.status).toBe(404);
  });

  it('6. cross-workspace isolation: two workspaces sharing the identical select-field value produce independent topic edges (no bleed)', async () => {
    const { cookie: cookieA, workspaceId: workspaceIdA } = await registerOwnerWithWorkspace();
    const { cookie: cookieB, workspaceId: workspaceIdB } = await registerOwnerWithWorkspace();

    for (const [cookie, workspaceId] of [
      [cookieA, workspaceIdA],
      [cookieB, workspaceIdB],
    ] as const) {
      await defineField(cookie, workspaceId, {
        key: 'severity',
        label: 'Severity',
        fieldType: 'select',
        config: { options: [{ value: 'isolated-topic', label: 'Isolated Topic' }] },
        permissions: EDIT_ALL_PERMISSIONS,
      });
    }

    const rootA = await createObject(cookieA, workspaceIdA, 'Isolation root A');
    await createObject(cookieB, workspaceIdB, 'Isolation root B');
    await setFieldValues(cookieA, workspaceIdA, rootA.id, { severity: 'isolated-topic' });

    await syncOnce();

    const responseA = await getContext(cookieA, workspaceIdA, rootA.id);
    expect(responseA.status).toBe(200);
    const bodyA = responseA.body as ContextResponseBody;

    const topicEdgesA = bodyA.edges.filter(
      (edge) =>
        edge.edgeType === 'entity-topic' &&
        edge.sourceFieldKey === 'severity' &&
        edge.node.naturalKey === 'isolated-topic',
    );
    expect(topicEdgesA).toHaveLength(1);
  });

  it('7. guard stack: unauthenticated requests are rejected with 401, non-members with 403, the member themselves succeeds', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const root = await createObject(ownerCookie, workspaceId, 'Guard root');
    await syncOnce();

    const noSessionResponse = await request(server).get(contextUrl(workspaceId, root.id));
    expect(noSessionResponse.status).toBe(401);

    const { cookie: outsiderCookie } = await registerUser();
    const outsiderResponse = await getContext(outsiderCookie, workspaceId, root.id);
    expect(outsiderResponse.status).toBe(403);

    const ownerResponse = await getContext(ownerCookie, workspaceId, root.id);
    expect(ownerResponse.status).toBe(200);
  });

  function getContextSorted(
    cookie: string,
    workspaceId: string,
    objectId: string,
    sort: string,
  ): request.Test {
    return request(server)
      .get(`${contextUrl(workspaceId, objectId)}?sort=${sort}`)
      .set('Cookie', cookie);
  }

  /**
   * F2-T4 (RED step, `sort=relevance` half, ADR-0021). `relevance-scoring.ts`
   * / `ContextService.getContext`'s third `options` parameter /
   * `ContextController`'s `sort` query param do not exist yet -- every `it`
   * below is expected to fail RED today: either a 400 from the (not-yet-
   * relaxed) `.strict()` query validation rejecting an unknown `sort` key, a
   * 500 from `ContextService.getContext` being called with an unsupported
   * third argument, or an assertion failure because the response is simply
   * unsorted.
   */
  it('8. GET .../context/:objectId with NO sort param carries the exact same DTO shape as today -- no relevanceScore field anywhere, top-level keys unchanged (ADR-0021 Karar a regression proof)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const root = await createObject(cookie, workspaceId, 'No-sort shape root');
    const neighbor = await createObject(cookie, workspaceId, 'No-sort shape neighbor');
    await createRelation(cookie, workspaceId, root.id, neighbor.id);

    await syncOnce();

    const response = await getContext(cookie, workspaceId, root.id);
    expect(response.status).toBe(200);
    const body = response.body as ContextResponseBody;

    expect(Object.keys(body).sort()).toEqual(['asOf', 'edges', 'entity'].sort());
    expect(body.edges.length).toBeGreaterThan(0);
    for (const edge of body.edges) {
      expect(edge).not.toHaveProperty('relevanceScore');
    }
  });

  it('9. GET .../context/:objectId?sort=relevance orders scorable entity-topic edges by descending relevance -- a recently-set value ranks before an older one of the same edge type/weight', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, {
      key: 'old-topic',
      label: 'Old Topic',
      fieldType: 'select',
      config: { options: [{ value: 'stale-value', label: 'Stale Value' }] },
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, {
      key: 'new-topic',
      label: 'New Topic',
      fieldType: 'select',
      config: { options: [{ value: 'fresh-value', label: 'Fresh Value' }] },
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const root = await createObject(cookie, workspaceId, 'Relevance order root');
    await setFieldValues(cookie, workspaceId, root.id, {
      'old-topic': 'stale-value',
      'new-topic': 'fresh-value',
    });

    await syncOnce();

    // Backdate the "old-topic" edge's `createdAt` by 30 days (> 1 half-life)
    // directly via `rawDb`, so it unambiguously scores lower than the
    // "new-topic" edge despite sharing the identical `entity-topic` base
    // weight -- isolating the assertion to the damping factor alone.
    const [oldEdgeRow] = await rawDb
      .select({ id: contextGraphEdges.id })
      .from(contextGraphEdges)
      .where(
        and(
          eq(contextGraphEdges.workspaceId, workspaceId),
          eq(contextGraphEdges.edgeType, 'entity-topic'),
          eq(contextGraphEdges.sourceFieldKey, 'old-topic'),
        ),
      );
    expect(oldEdgeRow).toBeDefined();
    if (!oldEdgeRow) {
      throw new Error('old-topic entity-topic edge row not found');
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await rawDb
      .update(contextGraphEdges)
      .set({ createdAt: thirtyDaysAgo })
      .where(eq(contextGraphEdges.id, oldEdgeRow.id));

    const response = await getContextSorted(cookie, workspaceId, root.id, 'relevance');
    expect(response.status).toBe(200);
    const body = response.body as ContextResponseBody;

    const newTopicIndex = body.edges.findIndex(
      (edge) => edge.edgeType === 'entity-topic' && edge.sourceFieldKey === 'new-topic',
    );
    const oldTopicIndex = body.edges.findIndex(
      (edge) => edge.edgeType === 'entity-topic' && edge.sourceFieldKey === 'old-topic',
    );

    expect(newTopicIndex).toBeGreaterThanOrEqual(0);
    expect(oldTopicIndex).toBeGreaterThanOrEqual(0);
    expect(newTopicIndex).toBeLessThan(oldTopicIndex);
  });

  it('10. GET .../context/:objectId?sort=relevance places the structural entity-entity edge AFTER every scorable edge, regardless of age (ADR-0021 Karar d)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, {
      key: 'structural-check-topic',
      label: 'Structural Check Topic',
      fieldType: 'select',
      config: { options: [{ value: 'topic-value', label: 'Topic Value' }] },
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const root = await createObject(cookie, workspaceId, 'Structural order root');
    const neighbor = await createObject(cookie, workspaceId, 'Structural order neighbor');
    await createRelation(cookie, workspaceId, root.id, neighbor.id);
    await setFieldValues(cookie, workspaceId, root.id, { 'structural-check-topic': 'topic-value' });

    await syncOnce();

    const response = await getContextSorted(cookie, workspaceId, root.id, 'relevance');
    expect(response.status).toBe(200);
    const body = response.body as ContextResponseBody;

    const entityEntityIndex = body.edges.findIndex(
      (edge) => edge.edgeType === 'entity-entity' && edge.node.entityId === neighbor.id,
    );
    expect(entityEntityIndex).toBeGreaterThanOrEqual(0);

    const scorableIndices = body.edges
      .map((edge, index) => ({ edgeType: edge.edgeType, index }))
      .filter((entry) =>
        ['entity-time', 'entity-topic', 'person-topic', 'person-time'].includes(entry.edgeType),
      )
      .map((entry) => entry.index);
    expect(scorableIndices.length).toBeGreaterThan(0);

    for (const scorableIndex of scorableIndices) {
      expect(entityEntityIndex).toBeGreaterThan(scorableIndex);
    }
  });

  it('11. GET .../context/:objectId?sort=invalid is rejected with 400 (zod .strict() enum validation)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const root = await createObject(cookie, workspaceId, 'Invalid sort root');
    await syncOnce();

    const response = await getContextSorted(cookie, workspaceId, root.id, 'invalid');
    expect(response.status).toBe(400);
  });

  it('12. GET .../context/:objectId?sort=relevance preserves the exact ContextEdgeSummary DTO shape -- no new relevanceScore field leaks out even though the ORDER changed (ADR-0021 Karar a)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, {
      key: 'shape-check-topic',
      label: 'Shape Check Topic',
      fieldType: 'select',
      config: { options: [{ value: 'shape-value', label: 'Shape Value' }] },
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const root = await createObject(cookie, workspaceId, 'Shape check root');
    await setFieldValues(cookie, workspaceId, root.id, { 'shape-check-topic': 'shape-value' });

    await syncOnce();

    const response = await getContextSorted(cookie, workspaceId, root.id, 'relevance');
    expect(response.status).toBe(200);
    const body = response.body as ContextResponseBody;

    expect(Object.keys(body).sort()).toEqual(['asOf', 'edges', 'entity'].sort());
    expect(body.edges.length).toBeGreaterThan(0);

    const expectedEdgeKeys = [
      'direction',
      'edgeType',
      'node',
      'sourceFieldKey',
      'sourceRelationId',
    ];
    for (const edge of body.edges) {
      expect(Object.keys(edge).sort()).toEqual([...expectedEdgeKeys].sort());
      expect(edge).not.toHaveProperty('relevanceScore');
    }
  });
});
