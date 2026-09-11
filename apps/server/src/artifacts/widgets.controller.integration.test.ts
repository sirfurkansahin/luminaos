import crypto from 'node:crypto';

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
 * F3-T8 PR2 (RED step, ADR-0042 Karar c/d/i) — real, end-to-end HTTP-level
 * integration test for `POST /workspaces/:workspaceId/artifacts/widgets`.
 * Mirrors `./artifacts.controller.integration.test.ts`'s EXACT harness
 * (same Testcontainers Postgres 16 + Redis 7 pair, same raw `rawDb` escape
 * hatch for inserting a `guest`-role membership row directly, same
 * `toCookieHeader` helper, same `unconfiguredResponder`'s `RETURN:` marker
 * convention for scripting the mock AI provider's response text).
 *
 * ============================================================================
 * RED STATE (expected, today): there is no `WidgetsModule`/`WidgetsController`/
 * `WidgetsService`/`compile-widget-query.ts` yet, and `AppModule` does not
 * wire any `/artifacts/widgets` route (it isn't even registered as a sibling
 * route on the existing `ArtifactsModule`/`ArtifactsController`). Every
 * request below is therefore expected to 404 via Nest's own default
 * "Cannot POST ..." handler (no matching route at all), NOT via
 * `AppErrorFilter` mapping an `AppError` -- this file's assertions will fail
 * with e.g. "expected 404 to be 201". That is the correct red: it means the
 * ROUTE doesn't exist yet. `implementer` must add `WidgetsController`
 * (registered on `ArtifactsModule`, per ADR-0042 Karar a/i) to turn this
 * green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   POST /workspaces/:workspaceId/artifacts/widgets
 *     body: { prompt: string (1..4000), objectType: string (1..100),
 *             themePreset: 'kurumsal'|'canli'|'minimal' } (`.strict()` --
 *             unknown keys rejected)
 *     -> 201 { object: <ObjectWithFieldValues> } on success, mirroring
 *        `POST .../artifacts`'s own 201 (this creates a new Lumina Object).
 *        `fieldValues.artifactType === 'dashboard'` ALWAYS (regardless of
 *        the requested `objectType`), `fieldValues.querySpec` a valid JSON
 *        string round-tripping through `querySpecSchema`, `fieldValues.
 *        htmlContent` containing rendered `<table>` markup (ADR-0042 Karar
 *        d/g/h -- widget content comes from REAL query rows, not AI text).
 *     -> 400 on a malformed body (missing `prompt`, invalid `themePreset`
 *        enum value, unknown extra key).
 *     -> 401 when unauthenticated (no session cookie).
 *     -> 403 when the caller is authenticated but not a member of this
 *        workspace.
 *     -> RBAC (ADR-0042 Karar i, "member+, same base as ADR-0041 Karar g"):
 *        guarded ONLY by `SessionAuthGuard` + `WorkspaceMembershipGuard` --
 *        a `guest`-role member's request must still succeed (201), because
 *        `WidgetsService.generate()`'s internal `setFieldValues` write uses
 *        the FIXED `'owner'` role, never the caller's own `callerRole` (the
 *        SAME `'owner'`-bypass regression `./artifacts.controller.
 *        integration.test.ts` already proves for `ArtifactsService`).
 *
 * Regression (identical to `./artifacts.controller.integration.test.ts`'s own
 * "POST .../objects/query already covers artifact objects" test): a
 * freshly-created widget `artifact` object is immediately visible via
 * `POST /workspaces/:workspaceId/objects/query` with
 * `{ objectType: 'artifact', filters: [] }`, with ZERO code changes to
 * `objects.controller.ts`/`objects.service.ts`.
 *
 * AI usage quota/lock discipline (mirrors `./artifacts.service.integration.
 * test.ts`'s own quota-rejection test, at the HTTP layer here): seeding a raw
 * `ai_usage_records` row that already meets the configured token quota causes
 * a SUBSEQUENT widget-generation request to fail with
 * `QuotaExceededError`'s mapped HTTP status (429), proving
 * `AIUsageService.assertAITokenQuotaNotExceeded` is genuinely wired into
 * `WidgetsService.generate()`, not bypassed.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

/**
 * `AI_PROVIDER`'s production fallback responder (`unconfiguredResponder`,
 * `apps/server/src/ai/ai-provider.module.ts`) answers every generation call
 * in this test file (no `ANTHROPIC_API_KEY` configured) -- it echoes back
 * everything after a literal `RETURN:` substring found anywhere in the
 * rendered prompt. `validBody()`'s default `prompt` embeds this marker plus a
 * schema-valid, allowlist-valid `QuerySpec` JSON so `compileWidgetQuery`
 * actually succeeds. Mirrors `./artifacts.controller.integration.test.ts`'s
 * identical convention.
 */
const RETURN_MARKER = 'RETURN:';

/** A well-formed QuerySpec JSON against the "task" object type: no filters
 * (an always-valid, empty query), sorted by "title" -- "title" is always an
 * allowed reference regardless of which custom fields exist on "task", so
 * this body never depends on `task`'s own seeded field keys. */
function validQuerySpecJson(): string {
  return JSON.stringify({
    objectType: 'task',
    filters: [],
    sort: [{ field: 'title', direction: 'asc' }],
  });
}

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
  return `widgets-controller-test-user-${String(emailCounter)}@example.com`;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: `${RETURN_MARKER}${validQuerySpecJson()}`,
    objectType: 'task',
    themePreset: 'kurumsal',
    ...overrides,
  };
}

describe('POST /workspaces/:workspaceId/artifacts/widgets (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // No real Anthropic key -- falls back to MockProvider, same as every
    // other integration test in this codebase.
    delete process.env.ANTHROPIC_API_KEY;
    // Generous by default -- most of this file's tests are NOT about quota
    // enforcement (that's this file's own dedicated describe block below).
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

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
    const workspaceId = await createWorkspace(cookie, `Widgets Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  /** Mirrors `./artifacts.controller.integration.test.ts`'s `addMemberWithRole`
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

  /** Mirrors `./artifacts.service.integration.test.ts`'s `seedUsageRow`
   * convention: inserts an `ai_usage_records` row DIRECTLY via raw SQL,
   * bypassing `recordAIUsage`, so a quota test can control the exact
   * cumulative usage `assertAITokenQuotaNotExceeded` reads without a real
   * prior provider call. */
  async function seedUsageRow(
    workspaceId: string,
    overrides: { inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    await rawDb.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        crypto.randomUUID(),
        workspaceId,
        null,
        null,
        overrides.inputTokens ?? 0,
        overrides.outputTokens ?? 0,
        null,
        null,
      ],
    );
  }

  function widgetsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/artifacts/widgets`;
  }

  function queryUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects/query`;
  }

  describe('success path', () => {
    it('returns 201 { object } with querySpec/htmlContent/themePreset/generationPrompt/artifactType populated, for an owner-role member', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;

      expect(object.type).toBe('artifact');
      expect(object.workspaceId).toBe(workspaceId);

      // ALWAYS 'dashboard', regardless of the requested objectType ('task'
      // here) -- ADR-0042 Karar (b)/(d).
      expect(object.fieldValues.artifactType).toBe('dashboard');
      expect(object.fieldValues.themePreset).toBe('kurumsal');
      expect(object.fieldValues.generationPrompt).toBe(body.prompt);

      // querySpec is a JSON string that round-trips through querySpecSchema.
      expect(typeof object.fieldValues.querySpec).toBe('string');
      const parsedQuerySpec: unknown = JSON.parse(object.fieldValues.querySpec as string);
      expect(parsedQuerySpec).toMatchObject({ objectType: 'task' });

      // htmlContent contains rendered table markup -- the widget's content
      // comes from real query rows (buildQueryResultTableSection), not
      // AI-authored text (ADR-0042 Karar d/g/h).
      expect(typeof object.fieldValues.htmlContent).toBe('string');
      expect(object.fieldValues.htmlContent as string).toContain('<table>');
    });

    it("RBAC (ADR-0042 Karar i): a GUEST-role member (the least-privileged role) can still successfully generate a widget -- no stricter gate than plain membership, because the internal field-value write uses the fixed 'owner' role, not the caller's own", async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', guestCookie)
        .send(validBody());

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;
      expect(object.type).toBe('artifact');
      expect(object.fieldValues.artifactType).toBe('dashboard');
    });
  });

  describe('validation failures -> 400', () => {
    it('rejects a body missing "prompt"', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();
      delete (body as { prompt?: unknown }).prompt;

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(response.status).toBe(400);
    });

    it('rejects an invalid "themePreset" enum value', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ themePreset: 'neon' }));

      expect(response.status).toBe(400);
    });

    it('rejects an unknown extra body key (mass-assignment protection, `.strict()`)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ unexpectedField: 'nope' }));

      expect(response.status).toBe(400);
    });
  });

  describe('authentication/authorization', () => {
    it('returns 401 when the request carries no session cookie at all', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server).post(widgetsUrl(workspaceId)).send(validBody());

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is authenticated but not a member of this workspace', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const { cookie: outsiderCookie } = await registerUser();

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', outsiderCookie)
        .send(validBody());

      expect(response.status).toBe(403);
    });
  });

  describe('regression: POST .../objects/query already covers widget artifact objects, with ZERO code changes to objects.controller.ts/objects.service.ts', () => {
    it('a freshly-created widget artifact object is immediately visible via POST /workspaces/:workspaceId/objects/query with { objectType: "artifact" }', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();

      const createResponse = await request(server)
        .post(widgetsUrl(workspaceId))
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
      expect(found?.fieldValues.artifactType).toBe('dashboard');
    });
  });

  describe('AI usage quota discipline is genuinely exercised (not bypassed)', () => {
    it('rejects with a 429 (QuotaExceededError) and creates NO artifact object when the workspace TOKEN quota is already met', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      // Push this workspace's cumulative usage to/above whatever
      // AI_TOKEN_QUOTA_PER_WORKSPACE this suite is configured with -- a
      // single seeded row of exactly that size guarantees
      // assertAITokenQuotaNotExceeded rejects the very next call.
      const quota = Number(process.env.AI_TOKEN_QUOTA_PER_WORKSPACE ?? '0');
      await seedUsageRow(workspaceId, { inputTokens: quota, outputTokens: 0 });

      const response = await request(server)
        .post(widgetsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody());

      expect(response.status).toBe(429);

      const queryResponse = await request(server)
        .post(queryUrl(workspaceId))
        .set('Cookie', cookie)
        .send({ objectType: 'artifact', filters: [] });

      expect(queryResponse.status).toBe(200);
      const { objects } = queryResponse.body as ObjectsQueryResult;
      expect(objects).toHaveLength(0);
    });
  });
});
