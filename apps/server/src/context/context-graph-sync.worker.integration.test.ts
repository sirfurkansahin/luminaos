import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { contextGraphNodes } from '../db/schema/context-graph-nodes.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T2 (RED step, worker half). Pins `ContextGraphSyncWorker`
 * (`apps/server/src/context/context-graph-sync.worker.ts`), ADR-0018 Karar
 * (a): a `CalendarSyncPollerService`-shaped periodic worker (`OnModuleInit`/
 * `OnModuleDestroy`, `setInterval`, a public `syncOnce()` directly callable
 * by tests) whose `syncOnce()` calls `projectionRunner.catchUp
 * (contextGraphProjection)` — turning the previously "not live" context
 * graph projection (ADR-0017 Karar h) into an eventually-consistent one,
 * `SYNC_INTERVAL_MS = 5_000`.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *  - `context/context-graph-sync.worker.ts` (new) — `@Injectable()
 *    ContextGraphSyncWorker implements OnModuleInit, OnModuleDestroy`,
 *    injecting `ProjectionRunner` and a `ContextGraphProjection` instance.
 *    `SYNC_INTERVAL_MS = 5_000` (5 seconds — NOT `CalendarSyncPollerService`'s
 *    5 minutes, per ADR-0018 Karar a's explicit distinction).
 *      - `onModuleInit()`: starts `setInterval(() => void this.syncOnce(),
 *        SYNC_INTERVAL_MS)`.
 *      - `onModuleDestroy()`: `clearInterval`s that handle.
 *      - `async syncOnce(): Promise<void>`: calls
 *        `projectionRunner.catchUp(contextGraphProjection)` — nothing more.
 *  - `context/context.module.ts` (new) registers this worker as a provider
 *    (so `app.get(ContextGraphSyncWorker)` resolves once wired into
 *    `AppModule`).
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: same Testcontainers Postgres 16 + Redis 7 pair, register/
 * create-workspace/create-object HTTP helpers as every other integration test
 * in this codebase, duplicated here per this codebase's established
 * self-contained-integration-test convention. Raw reads against
 * `context_graph_nodes`/`context_graph_edges` (real, already-merged F2-T1
 * schema — NOT part of this PR's red surface) are the oracle for "did
 * `syncOnce()` actually run `catchUp`".
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./context-graph-sync.worker.ts` does not
 * exist, so the dynamic `import('./context-graph-sync.worker.js')` inside
 * `beforeAll` REJECTS ("Cannot find module"), failing `beforeAll` and thus
 * every `it` in this file — the correct red: the worker this task adds
 * simply does not exist yet, not a test-logic bug. Once that file exists but
 * before `context.module.ts` wires it into `AppModule`, the failure mode
 * shifts to `app.get(ContextGraphSyncWorker)` throwing Nest's "no provider
 * found" error.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface ObjectEnvelope {
  object: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `context-sync-worker-test-user-${String(emailCounter)}@example.com`;
}

/**
 * `context-graph-sync.worker.ts` doesn't exist yet, so a `type`-only import
 * of `ContextGraphSyncWorker` would resolve to `any`, cascading
 * `@typescript-eslint/no-unsafe-*` errors through every line touching it.
 * This narrow `*Like`/`*Constructor` escape hatch mirrors
 * `calendar-sync-poller.integration.test.ts`'s identical technique — once the
 * real module exists with this shape, the cast becomes a no-op.
 */
interface ContextGraphSyncWorkerLike {
  syncOnce(): Promise<void>;
}

interface ContextGraphSyncWorkerConstructor {
  new (...args: unknown[]): ContextGraphSyncWorkerLike;
}

describe('F2-T2 (RED step): ContextGraphSyncWorker -- periodic context-graph catch-up (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    expect((registerResponse.body as UserEnvelope).user.id).toBeDefined();

    const workspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Context sync worker test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function createObject(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });
    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  async function findEntityNode(
    workspaceId: string,
    objectId: string,
  ): Promise<typeof contextGraphNodes.$inferSelect | undefined> {
    const rows = await rawDb
      .select()
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          eq(contextGraphNodes.nodeType, 'entity'),
          eq(contextGraphNodes.naturalKey, objectId),
        ),
      );
    return rows[0];
  }

  async function countEntityNodes(workspaceId: string): Promise<number> {
    const rows = await rawDb
      .select({ id: contextGraphNodes.id })
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          eq(contextGraphNodes.nodeType, 'entity'),
        ),
      );
    return rows.length;
  }

  async function countEdgesForNode(workspaceId: string, entityNodeId: string): Promise<number> {
    const rows = await rawDb
      .select({ id: contextGraphEdges.id })
      .from(contextGraphEdges)
      .where(
        and(
          eq(contextGraphEdges.workspaceId, workspaceId),
          eq(contextGraphEdges.fromNodeId, entityNodeId),
        ),
      );
    return rows.length;
  }

  it('1. syncOnce() drives a real catch-up: an object created via HTTP has NO context_graph row until syncOnce() runs, then does', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const objectId = await createObject(cookie, workspaceId, 'Needs syncing');

    // Before any syncOnce() call, ADR-0017's projection is not live (Karar
    // h) -- no service wires `catchUp` into the write path -- so the entity
    // node must not exist yet.
    expect(await findEntityNode(workspaceId, objectId)).toBeUndefined();

    const worker = app.get(ContextGraphSyncWorker);
    await worker.syncOnce();

    const entityNode = await findEntityNode(workspaceId, objectId);
    expect(entityNode).toBeDefined();
    expect(entityNode?.objectType).toBe('task');

    // At least the entity-time edge (every actor type) must exist.
    if (entityNode) {
      expect(await countEdgesForNode(workspaceId, entityNode.id)).toBeGreaterThan(0);
    }
  });

  it('2. repeated syncOnce() calls are idempotent (no duplicate rows) AND pick up objects created between calls', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const firstObjectId = await createObject(cookie, workspaceId, 'First');

    const worker = app.get(ContextGraphSyncWorker);
    await worker.syncOnce();
    const countAfterFirstSync = await countEntityNodes(workspaceId);
    expect(countAfterFirstSync).toBe(1);

    // A second immediate syncOnce() with nothing new must not duplicate the
    // already-synced entity node.
    await worker.syncOnce();
    expect(await countEntityNodes(workspaceId)).toBe(countAfterFirstSync);

    // A newly created object, synced on a THIRD call, must also appear --
    // proving the worker is genuinely repeatable/periodic, not a one-shot.
    const secondObjectId = await createObject(cookie, workspaceId, 'Second');
    await worker.syncOnce();

    expect(await findEntityNode(workspaceId, firstObjectId)).toBeDefined();
    expect(await findEntityNode(workspaceId, secondObjectId)).toBeDefined();
    expect(await countEntityNodes(workspaceId)).toBe(2);
  });

  it('3. onModuleDestroy() clears the sync interval (mirrors CalendarSyncPollerService test 5)', async () => {
    const { AppModule } = await import('../app.module.js');

    const secondModuleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const secondApp = secondModuleRef.createNestApplication();
    await secondApp.init();

    // Force-resolve the worker so we know `onModuleInit` (and thus the
    // `setInterval`) has definitely run before we assert on cleanup.
    secondApp.get(ContextGraphSyncWorker);

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    try {
      await secondApp.close();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  }, 30_000);
});
