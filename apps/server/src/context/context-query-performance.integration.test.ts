import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { contextGraphNodes } from '../db/schema/context-graph-nodes.js';
import { objectsView } from '../db/schema/objects-view.js';
import { projectionCheckpoints } from '../db/schema/projection-checkpoints.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T2's own `<100ms` acceptance criterion (ADR-0018, spec Kabul
 * Kriterleri #1) -- mirrors `object-query-performance.integration.test.ts`'s
 * PROVEN pattern exactly: bypass event-sourcing entirely, seed
 * `context_graph_nodes`/`context_graph_edges` (and their supporting
 * `objects_view`/`projection_checkpoints` rows) directly via `rawDb`, then
 * measure ONLY the real `GET /workspaces/:workspaceId/context/:objectId`
 * HTTP round trip: 1 untimed warm-up + 3 timed samples + take the minimum +
 * assert `<100ms`.
 *
 * FIXTURE SCALE: one root entity with ~96 direct edges (30 entity-entity, 1
 * entity-person, 5 entity-time, 60 entity-topic split across ~10 distinct
 * `sourceFieldKey`s) -- a realistic "busy object" scale per this task's own
 * acceptance criterion, deliberately NOT a synthetic 10k-edge single-object
 * fixture (unrealistic for this endpoint's 1-hop-only scope, per the task's
 * own Kapsam DIŞI).
 *
 * No `field_definitions` rows are seeded here on purpose: this file measures
 * READ latency of the graph-traversal query itself, not RBAC-filtering cost
 * (that's `context.integration.test.ts`'s concern) -- every `entity-topic`
 * edge below is therefore visible to the querying owner regardless of role.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of `context.controller.ts`/`context.
 * service.ts`/`context.module.ts` exist yet, so `GET .../context/:objectId`
 * 404s via Nest's own default "Cannot GET ..." handler (no matching route),
 * failing every assertion in this file that expects `200`.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface ContextEdge {
  edgeType: string;
}

interface ContextResponseBody {
  asOf: string;
  entity: { entityId: string };
  edges: ContextEdge[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `context-query-perf-test-user-${String(emailCounter)}@example.com`;
}

describe('Context API: single-object graph-traversal performance (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;

  let cookie: string;
  let workspaceId: string;
  let rootObjectId: string;

  const ENTITY_ENTITY_COUNT = 30;
  const TIME_BUCKET_COUNT = 5;
  const TOPIC_FIELD_COUNT = 10;
  const TOPIC_VALUES_PER_FIELD = 6; // 10 * 6 = 60 entity-topic edges.

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());

    // --- 1. A real workspace/user via HTTP (the context query below
    // authenticates as this user). ---
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    const userId = (registerResponse.body as UserEnvelope).user.id;

    const workspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: 'Context Query Performance Workspace' });
    expect(workspaceResponse.status).toBe(201);
    workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    const now = new Date();

    // --- 2. The ROOT object, created via HTTP so `objects_view` has a real
    // title/fieldValues row for `ContextService` to look up. ---
    const rootResponse = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title: 'Perf root object' });
    expect(rootResponse.status).toBe(201);
    rootObjectId = (rootResponse.body as { object: { id: string } }).object.id;

    // --- 3. The root's `entity` context-graph node, inserted directly
    // (bypassing the sync worker/event log entirely -- this file measures
    // READ cost, not catch-up cost). ---
    const rootEntityNodeId = newObjectId();
    await rawDb.insert(contextGraphNodes).values({
      id: rootEntityNodeId,
      workspaceId,
      nodeType: 'entity',
      naturalKey: rootObjectId,
      objectType: 'task',
      createdAt: now,
    });

    // --- 4. Neighbor `entity` nodes (+ matching `objects_view` rows for
    // their titles) and `entity-entity` edges. ---
    const neighborObjectsRows: (typeof objectsView.$inferInsert)[] = [];
    const neighborNodeRows: (typeof contextGraphNodes.$inferInsert)[] = [];
    const neighborEdgeRows: (typeof contextGraphEdges.$inferInsert)[] = [];

    for (let index = 0; index < ENTITY_ENTITY_COUNT; index += 1) {
      const neighborObjectId = newObjectId();
      const neighborNodeId = newObjectId();

      neighborObjectsRows.push({
        id: neighborObjectId,
        streamId: randomUUID(),
        type: 'task',
        workspaceId,
        title: `Perf neighbor ${String(index)}`,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        lifecycle: 'active',
        fieldValues: {},
      });
      neighborNodeRows.push({
        id: neighborNodeId,
        workspaceId,
        nodeType: 'entity',
        naturalKey: neighborObjectId,
        objectType: 'task',
        createdAt: now,
      });
      neighborEdgeRows.push({
        id: newObjectId(),
        workspaceId,
        edgeType: 'entity-entity',
        fromNodeId: rootEntityNodeId,
        toNodeId: neighborNodeId,
        sourceFieldKey: null,
        sourceRelationId: newObjectId(),
        createdAt: now,
      });
    }

    await rawDb.insert(objectsView).values(neighborObjectsRows);
    await rawDb.insert(contextGraphNodes).values(neighborNodeRows);
    await rawDb.insert(contextGraphEdges).values(neighborEdgeRows);

    // --- 5. One `person` node + `entity-person` edge. ---
    const personNodeId = newObjectId();
    await rawDb.insert(contextGraphNodes).values({
      id: personNodeId,
      workspaceId,
      nodeType: 'person',
      naturalKey: userId,
      objectType: null,
      createdAt: now,
    });
    await rawDb.insert(contextGraphEdges).values({
      id: newObjectId(),
      workspaceId,
      edgeType: 'entity-person',
      fromNodeId: rootEntityNodeId,
      toNodeId: personNodeId,
      sourceFieldKey: null,
      sourceRelationId: null,
      createdAt: now,
    });

    // --- 6. `time` nodes + `entity-time` edges, one per distinct day. ---
    const timeNodeRows: (typeof contextGraphNodes.$inferInsert)[] = [];
    const timeEdgeRows: (typeof contextGraphEdges.$inferInsert)[] = [];

    for (let dayOffset = 0; dayOffset < TIME_BUCKET_COUNT; dayOffset += 1) {
      const dayKey = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const timeNodeId = newObjectId();

      timeNodeRows.push({
        id: timeNodeId,
        workspaceId,
        nodeType: 'time',
        naturalKey: dayKey,
        objectType: null,
        createdAt: now,
      });
      timeEdgeRows.push({
        id: newObjectId(),
        workspaceId,
        edgeType: 'entity-time',
        fromNodeId: rootEntityNodeId,
        toNodeId: timeNodeId,
        sourceFieldKey: null,
        sourceRelationId: null,
        createdAt: now,
      });
    }

    await rawDb.insert(contextGraphNodes).values(timeNodeRows);
    await rawDb.insert(contextGraphEdges).values(timeEdgeRows);

    // --- 7. `topic` nodes + `entity-topic` edges: TOPIC_FIELD_COUNT distinct
    // `sourceFieldKey`s, each contributing TOPIC_VALUES_PER_FIELD values. ---
    const topicNodeRows: (typeof contextGraphNodes.$inferInsert)[] = [];
    const topicEdgeRows: (typeof contextGraphEdges.$inferInsert)[] = [];

    for (let fieldIndex = 0; fieldIndex < TOPIC_FIELD_COUNT; fieldIndex += 1) {
      const fieldKey = `perf-field-${String(fieldIndex)}`;

      for (let valueIndex = 0; valueIndex < TOPIC_VALUES_PER_FIELD; valueIndex += 1) {
        const naturalKey = `perf-value-${String(fieldIndex)}-${String(valueIndex)}`;
        const topicNodeId = newObjectId();

        topicNodeRows.push({
          id: topicNodeId,
          workspaceId,
          nodeType: 'topic',
          naturalKey,
          objectType: null,
          createdAt: now,
        });
        topicEdgeRows.push({
          id: newObjectId(),
          workspaceId,
          edgeType: 'entity-topic',
          fromNodeId: rootEntityNodeId,
          toNodeId: topicNodeId,
          sourceFieldKey: fieldKey,
          sourceRelationId: null,
          createdAt: now,
        });
      }
    }

    await rawDb.insert(contextGraphNodes).values(topicNodeRows);
    await rawDb.insert(contextGraphEdges).values(topicEdgeRows);

    // --- 8. A synced `projection_checkpoints` row for `context-graph`, so
    // `asOf` resolves without needing a real `ContextGraphSyncWorker.
    // syncOnce()` call (this file bypasses the event log/worker entirely,
    // per its own header). ---
    await rawDb.insert(projectionCheckpoints).values({
      projectionName: 'context-graph',
      lastPosition: 0,
      updatedAt: now,
    });
  }, 300_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  function queryContext(): request.Test {
    return request(server)
      .get(`/workspaces/${workspaceId}/context/${rootObjectId}`)
      .set('Cookie', cookie);
  }

  it('GET .../context/:objectId for a ~96-edge root entity completes in under 100ms (warm-up + 3-sample minimum)', async () => {
    const expectedEdgeCount =
      ENTITY_ENTITY_COUNT + 1 + TIME_BUCKET_COUNT + TOPIC_FIELD_COUNT * TOPIC_VALUES_PER_FIELD;

    // Warm-up call, UNTIMED (same rationale as
    // `object-query-performance.integration.test.ts`'s own warm-up).
    const warmupResponse = await queryContext();
    expect(warmupResponse.status).toBe(200);
    const warmupBody = warmupResponse.body as ContextResponseBody;
    expect(warmupBody.entity.entityId).toBe(rootObjectId);
    expect(warmupBody.edges).toHaveLength(expectedEdgeCount);

    const SAMPLE_COUNT = 3;
    const measurementsMs: number[] = [];

    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const start = performance.now();
      const response = await queryContext();
      const elapsedMs = performance.now() - start;

      expect(response.status).toBe(200);
      measurementsMs.push(elapsedMs);
    }

    const bestMs = Math.min(...measurementsMs);

    console.log(
      `[context-query-performance] context query measurements (ms): ${measurementsMs.map((v) => v.toFixed(2)).join(', ')} -- best: ${bestMs.toFixed(2)}`,
    );

    expect(bestMs).toBeLessThan(100);
  }, 60_000);
});
