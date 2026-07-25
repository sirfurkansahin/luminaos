import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T6 PR-D — 10,000-object PERFORMANCE proof for the query/filter/sort/
 * group endpoint's own acceptance criterion: "<200ms tipik sorgu."
 *
 * ============================================================================
 * GREEN, NOT RED (see `object-query-remaining-types.integration.test.ts`'s
 * own header for the same disclaimer in full): the endpoint under test
 * (`POST /workspaces/:workspaceId/objects/query`) is already fully built and
 * merged (F1-T6 PR-A/B/C, this same branch), including its own dedicated
 * `(workspaceId, type, lifecycle)` composite btree index and `field_values`
 * GIN index (migration `0009_new_betty_brant.sql`). This file adds the
 * missing PERFORMANCE evidence the task's own acceptance criterion requires.
 * If the "typical query" assertion below is ever red, that is a genuine
 * performance regression in the merged implementation (or its indexes) --
 * report it, do not loosen the 200ms bound to force green.
 *
 * SEEDING STRATEGY (mirrors `object-formula-recompute.integration.test.ts`'s
 * own AC #5 10,000-object performance test -- the only existing precedent in
 * this codebase for seeding thousands of objects efficiently in a
 * performance test): field DEFINITIONS are inserted directly via `rawDb`
 * (bypassing HTTP -- the thing under test is QUERY cost, not
 * field-definition-creation cost). The 10,000 `task` OBJECTS themselves are
 * seeded as `objects_view` rows directly, via chunked bulk inserts, WITHOUT a
 * matching real `events` history for each one -- exactly the same choice
 * `object-formula-recompute.integration.test.ts`'s own precedent makes for
 * its 9,999 decoy objects ("nothing ever reads/appends to their event
 * streams in this test, so no matching `events` rows are needed for them").
 * The same reasoning applies here: this file's assertions only ever read
 * `objects_view` through the real `POST .../objects/query` HTTP path (never
 * replay any of these seeded objects' event streams, and never write to any
 * of them again), so a real, matching event history for all 10,000 would add
 * substantial seeding cost while proving nothing this file's own assertions
 * depend on. This does NOT touch the query path itself, which -- per
 * ADR-0003 -- only ever reads from `objects_view`, exactly as it does for
 * every real, production-seeded row.
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

const STATUS_OPTIONS = ['todo', 'doing', 'review', 'done', 'blocked'] as const;

/** Splits `items` into chunks of at most `size` -- same helper, same
 * reasoning (keeping bulk-insert statements under Postgres's per-query
 * bound-parameter limit), as
 * `object-formula-recompute.integration.test.ts`'s own `chunk`. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `object-query-perf-test-user-${String(emailCounter)}@example.com`;
}

describe('Lumina Object query endpoint: 10,000-object performance (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;

  let cookie: string;
  let workspaceId: string;
  const OBJECT_COUNT = 10_000;

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

    // --- 1. A single real workspace/user, via HTTP (the query calls below
    // authenticate as this user). ---
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
      .send({ name: 'Query Performance Workspace' });
    expect(workspaceResponse.status).toBe(201);
    workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    // --- 2. Field definitions, inserted directly (bypassing HTTP -- see
    // this file's header). ---
    const now = new Date();

    await rawDb.insert(fieldDefinitions).values([
      {
        id: newObjectId(),
        streamId: randomUUID(),
        workspaceId,
        objectType: 'task',
        key: 'status',
        label: 'Status',
        fieldType: 'select',
        config: { options: [...STATUS_OPTIONS] },
        permissions: EDIT_ALL_PERMISSIONS,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newObjectId(),
        streamId: randomUUID(),
        workspaceId,
        objectType: 'task',
        key: 'priority',
        label: 'Priority',
        fieldType: 'number',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newObjectId(),
        streamId: randomUUID(),
        workspaceId,
        objectType: 'task',
        key: 'notes',
        label: 'Notes',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // --- 3. 10,000 `task` objects, seeded directly as `objects_view` rows
    // via chunked bulk inserts (see this file's header for why this does
    // NOT need a matching real `events` history). Realistic-but-varied
    // field values: `status` cycles through all 5 options, `priority`
    // varies 0-999, `notes` a short per-row string. ---
    const rows: (typeof objectsView.$inferInsert)[] = [];

    for (let index = 0; index < OBJECT_COUNT; index += 1) {
      const status = STATUS_OPTIONS[index % STATUS_OPTIONS.length];
      const priority = index % 1000;

      rows.push({
        id: newObjectId(),
        streamId: randomUUID(),
        type: 'task',
        workspaceId,
        title: `Perf task ${String(index)}`,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        lifecycle: 'active',
        fieldValues: { status, priority, notes: `Note text for task ${String(index)}` },
      });
    }

    for (const batch of chunk(rows, 1_000)) {
      await rawDb.insert(objectsView).values(batch);
    }
  }, 300_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  function queryObjects(body: Record<string, unknown>): request.Test {
    return request(server)
      .post(`/workspaces/${workspaceId}/objects/query`)
      .set('Cookie', cookie)
      .send(body);
  }

  it('a typical filter+sort+limit query over 10,000 objects completes in under 200ms', async () => {
    const typicalQueryBody = {
      objectType: 'task',
      filters: [{ field: 'status', operator: 'equals', value: 'done' }],
      sort: [{ field: 'priority', direction: 'desc' }],
      limit: 50,
    };

    // Warm-up call, UNTIMED: absorbs first-call JIT/connection-pool-
    // acquisition noise (mirrors the "generous but explicit and bounded"
    // spirit of `health.integration.test.ts`'s own timing comment --
    // measuring a COLD first call here would penalize the query layer
    // itself for one-time costs no real "typical query" pays on every
    // request in a warm, already-running server).
    const warmupResponse = await queryObjects(typicalQueryBody);
    expect(warmupResponse.status).toBe(200);
    expect((warmupResponse.body as QueryFlatEnvelope).objects.length).toBeGreaterThan(0);
    expect((warmupResponse.body as QueryFlatEnvelope).objects.length).toBeLessThanOrEqual(50);

    // 3 further, timed measurements -- take the MINIMUM (the least noisy
    // sample) as the representative figure, rather than a single
    // measurement that could be skewed by unrelated transient scheduling
    // noise from the test runner/container itself.
    const SAMPLE_COUNT = 3;
    const measurementsMs: number[] = [];

    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const start = performance.now();
      const response = await queryObjects(typicalQueryBody);
      const elapsedMs = performance.now() - start;

      expect(response.status).toBe(200);
      measurementsMs.push(elapsedMs);
    }

    const bestMs = Math.min(...measurementsMs);

    // Deliberate: surfaces the actual measured numbers in CI/local output
    // for this performance assertion, same spirit as this file's header
    // documenting intent.
    console.log(
      `[object-query-performance] typical query measurements (ms): ${measurementsMs.map((v) => v.toFixed(2)).join(', ')} -- best: ${bestMs.toFixed(2)}`,
    );

    expect(bestMs).toBeLessThan(200);
  }, 60_000);

  it("a group-by-status query over the same 10,000 objects completes in reasonable (not hard-200ms) time, per this task's own approved v1 design (group mode fetches the full unbounded result set)", async () => {
    const start = performance.now();
    const response = await queryObjects({
      objectType: 'task',
      filters: [],
      group: 'status',
    });
    const elapsedMs = performance.now() - start;

    expect(response.status).toBe(200);
    const { groups } = response.body as QueryGroupEnvelope;

    expect(groups).toHaveLength(STATUS_OPTIONS.length);

    const expectedCountPerStatus = OBJECT_COUNT / STATUS_OPTIONS.length;
    for (const group of groups) {
      expect(group.count).toBe(expectedCountPerStatus);
      expect(group.items).toHaveLength(expectedCountPerStatus);
    }

    // Same rationale as the typical-query test's own `console.log` above.
    console.log(`[object-query-performance] group-by-status query: ${elapsedMs.toFixed(2)}ms`);

    // Secondary, less strict assertion (the task's own kabul kriteri only
    // mandates <200ms for "tipik sorgu" -- the flat/filtered case above).
    expect(elapsedMs).toBeLessThan(2_000);
  }, 60_000);
});
