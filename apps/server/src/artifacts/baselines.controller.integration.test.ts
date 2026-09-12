import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionResult } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T11 PR2 (RED step, ADR-0045 Karar e/h) ADDITION -- this file's original
 * F3-T10 harness (above) is otherwise UNCHANGED: `BaselinesService.capture()`
 * itself still has ZERO AI-gateway dependency (ADR-0044 Karar c), proven by
 * every pre-existing test below still passing with zero AI wiring involved
 * in the capture path. The NEW `POST .../baselines/:id/explain` route (ADR-
 * 0045 Karar e), however, DOES depend on AI (via the new, separate
 * `BaselineExplanationService`) -- so this file's `beforeAll` now ALSO
 * configures a generous AI token/cost quota and overrides `AI_PROVIDER` with
 * a fully-scripted `MockProvider` (`explainProviderResponder` below), rather
 * than relying on the production `unconfiguredResponder`'s `RETURN:` marker
 * convention (`ai-provider.module.ts`) -- that convention only works when
 * caller-supplied text is the LAST content embedded in the rendered prompt,
 * which is NOT the case for `explainDeviation`'s prompt template
 * (`./explain-deviation.ts`): it always ends with a fixed
 * `Direction: <up|down|unchanged>` line that the caller can never control,
 * so there is no way to make a `RETURN:`-marked suffix survive as the LAST
 * characters of the rendered prompt. `overrideProvider(AI_PROVIDER)` sidesteps
 * that positional constraint entirely -- mirrors
 * `trigger-suggestions.controller.integration.test.ts`'s own established
 * `overrideProvider` precedent (documented there for the identical reason:
 * `suggestTriggerTemplates`'s prompt template also always has fixed
 * instructions text after the caller-supplied content).
 */
let explainResponseCounter = 0;

function scriptedExplainResponse(): AICompletionResult {
  explainResponseCounter += 1;
  return {
    text: JSON.stringify({
      summary: `Deviation explanation attempt #${String(explainResponseCounter)}.`,
      possibleCauses: ['A plausible cause from the scripted test provider.'],
    }),
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}

/** Wrapped in `vi.fn` (not just a plain function) so tests below can assert
 * "the AI provider was invoked exactly N times" / "invoked zero additional
 * times" (ADR-0045 Karar h's cost-protection regression) directly against
 * this shared, module-scoped call-count, mirroring
 * `widgets.controller.integration.test.ts`'s `seedUsageRow`-based quota
 * assertions in spirit (observable side-effect count, not internal mocking). */
const explainProviderResponder = vi.fn(scriptedExplainResponse);

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

    // BaselinesService (capture) has ZERO AI-gateway dependency (ADR-0044
    // Karar c) -- no ANTHROPIC_API_KEY is needed here. The NEW `:id/explain`
    // route (F3-T11 PR2, ADR-0045) DOES depend on AI (via the new, separate
    // `BaselineExplanationService`), so a generous quota is configured and
    // `AI_PROVIDER` is overridden below with `explainProviderResponder`
    // (this file's own header doc comment explains why the production
    // `unconfiguredResponder`/`RETURN:` convention doesn't fit here).
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_PROVIDER)
      .useValue(new MockProvider(explainProviderResponder))
      .compile();
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

  /** Defines an ad-hoc `number` Custom Field on the `task` object type, so a
   * test can exercise a REAL numeric `targetFieldKey` for `avg`/`min`/`max`
   * aggregation (none of `seedTaskFields`'s built-ins -- `status`/`priority`/
   * `remindAt`/`remindAcknowledged` -- are numeric). Owner role satisfies
   * `FieldsController`'s `admin+` guard. */
  async function defineNumberField(
    cookie: string,
    workspaceId: string,
    key: string,
  ): Promise<void> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/object-types/task/fields`)
      .set('Cookie', cookie)
      .send({
        key,
        label: key,
        fieldType: 'number',
        config: {},
        permissions: { owner: 'edit', admin: 'edit', member: 'edit', guest: 'view' },
      });

    expect(response.status).toBe(201);
  }

  /** `PATCH .../objects/:objectId/fields` -- sets one or more Custom Field
   * values directly on an existing object. */
  async function patchFieldValues(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const response = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });

    expect(response.status).toBe(200);
  }

  /** A non-baseline `artifact` object, used to exercise the `:id/explain`
   * artifactType guard (ADR-0045) with ZERO interference with this file's
   * shared `explainProviderResponder` scripting. NOTE: the generic
   * `POST /workspaces/:workspaceId/objects` route's DTO
   * (`create-object.schema.ts`) only allows `objectType` to be
   * `task`/`doc`/`note`/`timeblock` -- `'artifact'` is deliberately NOT in
   * that enum (every `artifact` is created via one of the dedicated
   * generation routes: `.../artifacts`, `.../artifacts/widgets`,
   * `.../artifacts/baselines`). So instead: capture a real baseline via the
   * ALREADY-covered `POST .../baselines` route, then overwrite its
   * `artifactType` away from `'baseline'` to another seeded, valid `select`
   * option (`'report'`) via the ALREADY-covered `PATCH .../fields` route --
   * yielding a real `artifact` object whose `fieldValues.artifactType !==
   * 'baseline'`. */
  async function createPlainArtifact(cookie: string, workspaceId: string): Promise<string> {
    const baseline = await captureBaseline(cookie, workspaceId);
    await patchFieldValues(cookie, workspaceId, baseline.id, { artifactType: 'report' });
    return baseline.id;
  }

  function baselinesUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/artifacts/baselines`;
  }

  function explainUrl(workspaceId: string, baselineId: string): string {
    return `/workspaces/${workspaceId}/artifacts/baselines/${baselineId}/explain`;
  }

  /** Captures a real baseline via the ALREADY-covered `POST .../baselines`
   * route above, returning just the id + fieldValues the `:id/explain` tests
   * below need. */
  async function captureBaseline(
    cookie: string,
    workspaceId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; fieldValues: Record<string, unknown> }> {
    const response = await request(server)
      .post(baselinesUrl(workspaceId))
      .set('Cookie', cookie)
      .send(validBody(overrides));

    expect(response.status).toBe(201);
    const { object } = response.body as ObjectEnvelope;
    return { id: object.id, fieldValues: object.fieldValues };
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

  /**
   * F3-T11 PR2 (RED step, ADR-0045 Karar e/h) -- `POST .../baselines/:id/explain`.
   *
   * ============================================================================
   * RED STATE (expected, today): `BaselinesController` has no `:id/explain`
   * route and no second constructor param (`BaselineExplanationService`
   * doesn't exist yet either). Every request below is therefore expected to
   * 404 via Nest's own default "Cannot POST ..." handler (no matching route
   * at all), NOT via `AppErrorFilter` mapping an `AppError` -- this block's
   * assertions will fail with e.g. "expected 404 to be 200". That is the
   * correct red: it means the ROUTE doesn't exist yet. `implementer` must add
   * `BaselineExplanationService` (`./baseline-explanation.service.ts`) +
   * wire it as `BaselinesController`'s second collaborator + register its
   * `useFactory` on `ArtifactsModule` (ADR-0045 Karar e) to turn this green.
   * ============================================================================
   */
  describe('POST /workspaces/:workspaceId/artifacts/baselines/:id/explain (real Postgres + real HTTP, via Testcontainers + supertest, ADR-0045 Karar e/h)', () => {
    describe('success path', () => {
      it('200 { object } with explanationSummary/explanationCauses/explanationGeneratedAt populated, for an owner-role member', async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        await createTask(cookie, workspaceId, 'Task one');
        await createTask(cookie, workspaceId, 'Task two');
        const baseline = await captureBaseline(cookie, workspaceId);

        const callsBefore = explainProviderResponder.mock.calls.length;

        const response = await request(server)
          .post(explainUrl(workspaceId, baseline.id))
          .set('Cookie', cookie)
          .send();

        expect(response.status).toBe(200);
        const { object } = response.body as ObjectEnvelope;

        expect(typeof object.fieldValues.explanationSummary).toBe('string');
        expect(object.fieldValues.explanationSummary as string).toContain(
          'Deviation explanation attempt',
        );

        expect(typeof object.fieldValues.explanationCauses).toBe('string');
        const parsedCauses: unknown = JSON.parse(object.fieldValues.explanationCauses as string);
        expect(parsedCauses).toEqual(['A plausible cause from the scripted test provider.']);

        expect(typeof object.fieldValues.explanationGeneratedAt).toBe('string');
        expect(Number.isNaN(Date.parse(object.fieldValues.explanationGeneratedAt as string))).toBe(
          false,
        );

        // The AI provider was genuinely invoked exactly once for this call --
        // proves the route is really wired to `BaselineExplanationService`,
        // not returning a stubbed/hardcoded response.
        expect(explainProviderResponder.mock.calls.length).toBe(callsBefore + 1);
      });

      it("RBAC: a GUEST-role member (the least-privileged role) can still successfully call explain (200) -- no stricter gate than plain membership, because the internal field-value write uses the fixed 'owner' role, not the caller's own", async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        const baseline = await captureBaseline(cookie, workspaceId);
        const guestCookie = await addMemberWithRole(workspaceId, 'guest');

        const response = await request(server)
          .post(explainUrl(workspaceId, baseline.id))
          .set('Cookie', guestCookie)
          .send();

        expect(response.status).toBe(200);
        const { object } = response.body as ObjectEnvelope;
        expect(typeof object.fieldValues.explanationSummary).toBe('string');
      });

      it('a second explain() call OVERWRITES the previous explanationSummary -- no history/versioning kept (ADR-0045 Karar f)', async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        const baseline = await captureBaseline(cookie, workspaceId);

        const firstResponse = await request(server)
          .post(explainUrl(workspaceId, baseline.id))
          .set('Cookie', cookie)
          .send();
        expect(firstResponse.status).toBe(200);
        const firstSummary = (firstResponse.body as ObjectEnvelope).object.fieldValues
          .explanationSummary as string;

        const secondResponse = await request(server)
          .post(explainUrl(workspaceId, baseline.id))
          .set('Cookie', cookie)
          .send();
        expect(secondResponse.status).toBe(200);
        const secondSummary = (secondResponse.body as ObjectEnvelope).object.fieldValues
          .explanationSummary as string;

        // The scripted provider bumps its counter on every call, so a
        // genuinely fresh AI round-trip happened -- not a cached/idempotent
        // response.
        expect(secondSummary).not.toBe(firstSummary);

        // Only the LATEST value is retrievable anywhere -- no "previous
        // explanation" surfaces via a normal object read.
        const queryResponse = await request(server)
          .post(queryUrl(workspaceId))
          .set('Cookie', cookie)
          .send({ objectType: 'artifact', filters: [] });
        const found = (queryResponse.body as ObjectsQueryResult).objects.find(
          (object) => object.id === baseline.id,
        );
        expect(found?.fieldValues.explanationSummary).toBe(secondSummary);
      });
    });

    describe('artifactType guard -> 400', () => {
      it('rejects a non-baseline artifact object (no fieldValues.artifactType at all)', async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        const plainArtifactId = await createPlainArtifact(cookie, workspaceId);

        const response = await request(server)
          .post(explainUrl(workspaceId, plainArtifactId))
          .set('Cookie', cookie)
          .send();

        expect(response.status).toBe(400);
      });
    });

    describe('cost-protection -> 400, AI provider NEVER invoked (ADR-0045 Karar h, the most important regression in this block)', () => {
      /**
       * `computeQueryAggregate` must return `null` at EXPLAIN time, but NOT
       * at CAPTURE time -- `BaselinesService.capture()` (F3-T10, unmodified
       * by this PR) has no guard against a `null` `computeQueryAggregate`
       * result and would itself reject the capture with a 400 (the
       * `capturedValue` field is `number`-typed) if the aggregate were
       * already uncomputable at capture time. A naive "avg against a field
       * no task has" scenario is therefore uncapturable in the first place.
       * Instead: define a real numeric field, capture an `avg` baseline
       * filtered to `status = 'todo'` while exactly one matching task has a
       * numeric value set (capture succeeds, capturedValue = 10), then flip
       * that task's `status` away from `'todo'` so the SAME stored
       * `querySpec` matches zero rows by the time `:id/explain` re-runs the
       * query -- `computeQueryAggregate` then legitimately returns `null`
       * only at explain time.
       */
      it('rejects with 400 and does NOT increase the AI provider call count when computeQueryAggregate cannot compute a currentValue at explain time (data drifted since capture)', async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        await defineNumberField(cookie, workspaceId, 'metricValue');
        const taskId = await createTask(cookie, workspaceId, 'Task one');
        await patchFieldValues(cookie, workspaceId, taskId, { status: 'todo', metricValue: 10 });

        const baseline = await captureBaseline(cookie, workspaceId, {
          querySpec: {
            objectType: 'task',
            filters: [{ field: 'status', operator: 'equals', value: 'todo' }],
          },
          aggregateFn: 'avg',
          targetFieldKey: 'metricValue',
        });
        expect(baseline.fieldValues.capturedValue).toBe(10);

        await patchFieldValues(cookie, workspaceId, taskId, { status: 'done' });

        const callsBefore = explainProviderResponder.mock.calls.length;

        const response = await request(server)
          .post(explainUrl(workspaceId, baseline.id))
          .set('Cookie', cookie)
          .send();

        expect(response.status).toBe(400);
        expect(explainProviderResponder.mock.calls.length).toBe(callsBefore);
      });
    });

    describe('authentication/authorization', () => {
      it('returns 401 when the request carries no session cookie at all', async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        const baseline = await captureBaseline(cookie, workspaceId);

        const response = await request(server).post(explainUrl(workspaceId, baseline.id)).send();

        expect(response.status).toBe(401);
      });

      it('returns 403 when the caller is authenticated but not a member of this workspace', async () => {
        const { cookie, workspaceId } = await registerOwnerWithWorkspace();
        const baseline = await captureBaseline(cookie, workspaceId);
        const { cookie: outsiderCookie } = await registerUser();

        const response = await request(server)
          .post(explainUrl(workspaceId, baseline.id))
          .set('Cookie', outsiderCookie)
          .send();

        expect(response.status).toBe(403);
      });
    });
  });
});
