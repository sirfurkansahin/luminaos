import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T6 PR-C (RED step) — cursor-pagination-specific coverage for the new
 * `POST /workspaces/:workspaceId/objects/query` endpoint. Split out of
 * `object-query.integration.test.ts` (which pins the rest of the contract:
 * validation precedence, field-type filtering, sorting, grouping, hidden
 * field enforcement) purely to keep each file a manageable size — same
 * Testcontainers Postgres 16 + Redis 7 pair, dynamic `import('../app.module.js')`
 * AFTER env vars are set, same self-contained helper convention as every
 * other integration test file here.
 *
 * ============================================================================
 * RED STATE (expected, today): nothing under test exists yet. `POST
 * .../objects/query` 404s via Nest's own default handler (no matching route),
 * NOT `AppErrorFilter`. See `object-query.integration.test.ts`'s own header
 * for the full explanation of why 404-expecting assertions here ALSO check
 * `error.code === 'VALIDATION_ERROR'`/`'NOT_FOUND'` specifically, so a
 * coincidental raw-404-from-missing-route doesn't make a test spuriously
 * "green" before the route exists.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISIONS THIS FILE PINS:
 *
 * - `cursor` is an OPAQUE, implementation-defined token from this file's
 *   point of view. No test here hardcodes an expected cursor STRING value —
 *   a cursor is only ever captured from one response's `nextCursor` and
 *   passed back verbatim as the next request's `cursor`.
 * - `nextCursor` is present in a flat-mode response if and only if there are
 *   more matching rows beyond the returned page; absent on the final page.
 * - Walking every page (same `QuerySpec` each time, only `cursor` changing)
 *   and concatenating the results must reproduce the SAME order, with no
 *   duplicates and no gaps, as a single unpaginated request for the same
 *   `QuerySpec` (minus `limit`/`cursor`).
 * - A malformed/garbage `cursor` string -> `ValidationError` (400), never a
 *   500 and never silently ignored/treated as "no cursor".
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: { id: string; key: string; objectType: string };
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

interface QueryFlatEnvelope {
  objects: ObjectBody[];
  nextCursor?: string;
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

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `object-query-pagination-test-user-${String(emailCounter)}@example.com`;
}

describe('Lumina Object query endpoint — cursor pagination (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
    const workspaceId = await createWorkspace(
      cookie,
      `Query Pagination Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
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
      permissions: FieldPermissionsBody;
    },
  ): Promise<void> {
    const response = await request(server)
      .post(fieldsUrl(workspaceId, objectType))
      .set('Cookie', cookie)
      .send(body);

    expect(response.status).toBe(201);
    void (response.body as FieldDefinitionEnvelope);
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

  it('walks a full 5-item result set 2-at-a-time via "nextCursor", with the last page absent a cursor, no duplicates, no gaps, and matching the unpaginated order exactly', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'rank',
      label: 'Rank',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const created: ObjectBody[] = [];
    for (let rank = 1; rank <= 5; rank += 1) {
      const object = await createObject(cookie, workspaceId, 'task', `Rank ${String(rank)}`);
      await setFieldValues(cookie, workspaceId, object.id, { rank });
      created.push(object);
    }

    const baseSpec = {
      objectType: 'task',
      filters: [],
      sort: [{ field: 'rank', direction: 'asc' }],
    };

    // The single, unpaginated ground-truth order every paginated walk below
    // must reproduce exactly (minus pagination fields).
    const unpaginatedResponse = await queryObjects(cookie, workspaceId, baseSpec);
    expect(unpaginatedResponse.status).toBe(200);
    const unpaginatedIds = (unpaginatedResponse.body as QueryFlatEnvelope).objects.map((o) => o.id);
    expect(unpaginatedIds).toEqual(created.map((o) => o.id));

    const collectedIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    for (;;) {
      pageCount += 1;
      expect(pageCount).toBeLessThanOrEqual(10); // tripwire against an infinite loop bug

      const pageResponse = await queryObjects(cookie, workspaceId, {
        ...baseSpec,
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      expect(pageResponse.status).toBe(200);
      const page = pageResponse.body as QueryFlatEnvelope;

      collectedIds.push(...page.objects.map((o) => o.id));

      if (page.nextCursor === undefined) {
        // Last page: must hold exactly the final remainder (1 item, since
        // 5 items / 2 per page = pages of 2, 2, 1).
        expect(page.objects).toHaveLength(1);
        break;
      }

      expect(page.objects).toHaveLength(2);
      cursor = page.nextCursor;
    }

    expect(pageCount).toBe(3);
    expect(collectedIds).toEqual(unpaginatedIds);
    expect(new Set(collectedIds).size).toBe(collectedIds.length); // no duplicates
  });

  it('an invalid/malformed cursor string -> 400 VALIDATION_ERROR, not a 500', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await createObject(cookie, workspaceId, 'task', 'Irrelevant object');

    const response = await queryObjects(cookie, workspaceId, {
      objectType: 'task',
      filters: [],
      cursor: 'not-valid-base64-or-json',
    });

    expect(response.status).toBe(400);
    expect((response.body as ApiErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  });
});
