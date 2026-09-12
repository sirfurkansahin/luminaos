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
 * F3-T10 PR2 (RED step, ADR-0044 Karar c/d/g) — real, end-to-end HTTP-level
 * integration test for `POST /workspaces/:workspaceId/artifacts/baselines`.
 * Mirrors `./widgets.controller.integration.test.ts`'s EXACT harness (same
 * Testcontainers Postgres 16 + Redis 7 pair, same raw `rawDb` escape hatch
 * for inserting a `guest`-role membership row directly, same
 * `toCookieHeader` helper). Unlike `WidgetsService`, `BaselinesService` has
 * ZERO AI-gateway dependency (ADR-0044 Karar c) -- no `ANTHROPIC_API_KEY`/
 * quota env wiring is needed anywhere in this file; `AI_TOKEN_QUOTA_PER_
 * WORKSPACE`/`AI_COST_BUDGET_USD_PER_WORKSPACE` are left at their (generous)
 * defaults (`../config/env.ts`) and never exercised.
 *
 * ============================================================================
 * RED STATE (expected, today): there is no `BaselinesController`/
 * `BaselinesService`/`dto/capture-baseline.schema.ts` yet, and `AppModule`
 * does not wire any `/artifacts/baselines` route (it isn't even registered
 * as a sibling route on the existing `ArtifactsModule`/`ArtifactsController`/
 * `WidgetsController`). Every request below is therefore expected to 404 via
 * Nest's own default "Cannot POST ..." handler (no matching route at all),
 * NOT via `AppErrorFilter` mapping an `AppError` -- this file's assertions
 * will fail with e.g. "expected 404 to be 201". That is the correct red: it
 * means the ROUTE doesn't exist yet. `implementer` must add
 * `BaselinesController` (registered on `ArtifactsModule`, per ADR-0044 Karar
 * a/g) to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   POST /workspaces/:workspaceId/artifacts/baselines
 *     body: { title: string (1..200), querySpec: QuerySpec, aggregateFn:
 *             'sum'|'avg'|'min'|'max'|'count'|'countUnique'|'countEmpty',
 *             targetFieldKey?: string (1..200) } (`.strict()` -- unknown
 *             keys rejected)
 *     -> 201 { object: <ObjectWithFieldValues> } on success, a REAL `artifact`
 *        Lumina Object: `fieldValues.artifactType === 'baseline'`,
 *        `fieldValues.capturedValue` a real number, `fieldValues.querySpec`
 *        a JSON string matching the sent `querySpec`, `fieldValues.
 *        aggregateFn` matching the sent value. `fieldValues.targetFieldKey`
 *        present ONLY when the request body provided one.
 *     -> 400 when `querySpec.group` is set (v0 flat-only, ADR-0044 Karar c/d).
 *     -> 400 when `aggregateFn` is anything other than `count` AND no
 *        `targetFieldKey` was provided (ADR-0044 Karar e).
 *     -> 400 on a malformed body (missing `title`/`querySpec`, invalid
 *        `aggregateFn` enum value, unknown extra key).
 *     -> 401 when unauthenticated (no session cookie).
 *     -> 403 when the caller is authenticated but not a member of this
 *        workspace.
 *     -> RBAC (ADR-0044 Karar g, "member+, same base as ADR-0041/0042"):
 *        guarded ONLY by `SessionAuthGuard` + `WorkspaceMembershipGuard` -- a
 *        `guest`-role member's request must still succeed (201), because
 *        `BaselinesService.capture()`'s internal `setFieldValues` write uses
 *        the FIXED `'owner'` role, never the caller's own `callerRole` (the
 *        SAME `'owner'`-bypass regression `./widgets.controller.integration.
 *        test.ts`/`./artifacts.controller.integration.test.ts` already prove).
 *
 * Regression (identical to `./widgets.controller.integration.test.ts`'s own
 * "POST .../objects/query already covers artifact objects" test): a
 * freshly-created baseline `artifact` object is immediately visible via
 * `POST /workspaces/:workspaceId/objects/query` with
 * `{ objectType: 'artifact', filters: [] }`, with ZERO code changes to
 * `objects.controller.ts`/`objects.service.ts`.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectEnvelope {
  object: {
    id: string;
    type: string;
    title: string;
    workspaceId: string;
    fieldValues: Record<string, unknown>;
  };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface ObjectsQueryResult {
  objects: ObjectEnvelope['object'][];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `baselines-controller-test-user-${String(emailCounter)}@example.com`;
}

/** A well-formed, flat (no `group`) QuerySpec against the "task" object
 * type, matching every "task" in the workspace (no filters). */
function flatTaskQuerySpec(): Record<string, unknown> {
  return { objectType: 'task', filters: [] };
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Doing tasks — baseline',
    querySpec: flatTaskQuerySpec(),
    aggregateFn: 'count',
    ...overrides,
  };
}

describe('POST /workspaces/:workspaceId/artifacts/baselines (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // BaselinesService has ZERO AI-gateway dependency (ADR-0044 Karar c) --
    // no ANTHROPIC_API_KEY/quota env wiring is needed here at all, unlike
    // `./widgets.controller.integration.test.ts`.
    delete process.env.ANTHROPIC_API_KEY;

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
      `Baselines Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  /** Mirrors `./widgets.controller.integration.test.ts`'s `addMemberWithRole`
   * exactly: inserts a membership row DIRECTLY (no invite-flow HTTP endpoint
   * exists in this codebase) so a role OTHER than `owner` can be exercised
   * against a real, cookie-authenticated user. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  async function createTask(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  function baselinesUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/artifacts/baselines`;
  }

  function queryUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects/query`;
  }

  describe('success path', () => {
    it('returns 201 { object } with artifactType/capturedValue/querySpec/aggregateFn populated, for an owner-role member', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;

      expect(object.type).toBe('artifact');
      expect(object.workspaceId).toBe(workspaceId);
      expect(object.fieldValues.artifactType).toBe('baseline');
      expect(typeof object.fieldValues.capturedValue).toBe('number');
      expect(object.fieldValues.aggregateFn).toBe('count');

      expect(typeof object.fieldValues.querySpec).toBe('string');
      const parsedQuerySpec: unknown = JSON.parse(object.fieldValues.querySpec as string);
      expect(parsedQuerySpec).toEqual(body.querySpec);
    });

    it('"count" WITHOUT targetFieldKey succeeds, capturedValue equals the real row count of matching "task" objects', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await createTask(cookie, workspaceId, 'Task one');
      await createTask(cookie, workspaceId, 'Task two');
      await createTask(cookie, workspaceId, 'Task three');

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody());

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;
      expect(object.fieldValues.capturedValue).toBe(3);
      expect(object.fieldValues.targetFieldKey).toBeUndefined();
    });

    it('targetFieldKey is written to fieldValues ONLY when provided in the request body', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ targetFieldKey: 'title' }));

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;
      expect(object.fieldValues.targetFieldKey).toBe('title');
    });

    it("RBAC (ADR-0044 Karar g): a GUEST-role member (the least-privileged role) can still successfully capture a baseline -- no stricter gate than plain membership, because the internal field-value write uses the fixed 'owner' role, not the caller's own", async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', guestCookie)
        .send(validBody());

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;
      expect(object.type).toBe('artifact');
      expect(object.fieldValues.artifactType).toBe('baseline');
    });
  });

  describe('v0 flat-only guard -> 400', () => {
    it('rejects a querySpec containing "group", no object is created', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const beforeResponse = await request(server)
        .post(queryUrl(workspaceId))
        .set('Cookie', cookie)
        .send({ objectType: 'artifact', filters: [] });
      const beforeCount = (beforeResponse.body as ObjectsQueryResult).objects.length;

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(
          validBody({
            querySpec: { objectType: 'task', filters: [], group: 'status' },
          }),
        );

      expect(response.status).toBe(400);

      const afterResponse = await request(server)
        .post(queryUrl(workspaceId))
        .set('Cookie', cookie)
        .send({ objectType: 'artifact', filters: [] });
      const afterCount = (afterResponse.body as ObjectsQueryResult).objects.length;

      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('targetFieldKey-required aggregateFn guard -> 400', () => {
    it('rejects "sum" without a targetFieldKey', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ aggregateFn: 'sum' }));

      expect(response.status).toBe(400);
    });

    it('rejects "avg"/"min"/"max"/"countUnique"/"countEmpty" without a targetFieldKey', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      for (const aggregateFn of ['avg', 'min', 'max', 'countUnique', 'countEmpty']) {
        const response = await request(server)
          .post(baselinesUrl(workspaceId))
          .set('Cookie', cookie)
          .send(validBody({ aggregateFn }));

        expect(response.status).toBe(400);
      }
    });
  });

  describe('validation failures -> 400', () => {
    it('rejects a body missing "title"', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();
      delete (body as { title?: unknown }).title;

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(response.status).toBe(400);
    });

    it('rejects a body missing "querySpec"', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();
      delete (body as { querySpec?: unknown }).querySpec;

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(response.status).toBe(400);
    });

    it('rejects an invalid "aggregateFn" enum value', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ aggregateFn: 'median' }));

      expect(response.status).toBe(400);
    });

    it('rejects an unknown extra body key (mass-assignment protection, `.strict()`)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ unexpectedField: 'nope' }));

      expect(response.status).toBe(400);
    });
  });

  describe('authentication/authorization', () => {
    it('returns 401 when the request carries no session cookie at all', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server).post(baselinesUrl(workspaceId)).send(validBody());

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is authenticated but not a member of this workspace', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const { cookie: outsiderCookie } = await registerUser();

      const response = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', outsiderCookie)
        .send(validBody());

      expect(response.status).toBe(403);
    });
  });

  describe('regression: POST .../objects/query already covers baseline artifact objects, with ZERO code changes to objects.controller.ts/objects.service.ts', () => {
    it('a freshly-created baseline artifact object is immediately visible via POST /workspaces/:workspaceId/objects/query with { objectType: "artifact" }', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();

      const createResponse = await request(server)
        .post(baselinesUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(createResponse.status).toBe(201);
      const createdId = (createResponse.body as ObjectEnvelope).object.id;

      const queryResponse = await request(server)
        .post(queryUrl(workspaceId))
        .set('Cookie', cookie)
        .send({ objectType: 'artifact', filters: [] });

      expect(queryResponse.status).toBe(200);
      const { objects } = queryResponse.body as ObjectsQueryResult;

      const found = objects.find((object) => object.id === createdId);
      expect(found).toBeDefined();
      expect(found?.type).toBe('artifact');
      expect(found?.fieldValues.artifactType).toBe('baseline');
    });
  });
});
