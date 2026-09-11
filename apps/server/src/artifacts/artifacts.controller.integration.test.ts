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
 * F3-T7 PR2 (RED step, ADR-0041 Karar g/h) — real, end-to-end HTTP-level
 * integration test for `POST /workspaces/:workspaceId/artifacts`. Mirrors
 * `../fields/field-definitions-security.integration.test.ts`'s harness
 * exactly (same Testcontainers Postgres 16 + Redis 7 pair, same raw `rawDb`
 * escape hatch for directly inserting a `guest`-role membership row,
 * same `toCookieHeader` helper).
 *
 * ============================================================================
 * RED STATE (expected, today): `AppModule` (`../app.module.ts`) does not
 * import an `ArtifactsModule` — there is no `artifacts.module.ts`,
 * `artifacts.controller.ts`, or `artifacts.service.ts` yet, and `'artifact'`
 * is not yet a registered `ObjectType`
 * (`packages/core-objects/src/object-type-registry.ts`). Every request below
 * to `/workspaces/:workspaceId/artifacts` is therefore expected to 404 via
 * Nest's own default "Cannot POST ..." handler (there is no matching route
 * at all), NOT via `AppErrorFilter` mapping an `AppError` — this file's
 * assertions will fail with e.g. "expected 404 to be 201" or similar. That is
 * the correct red: it means the ROUTE doesn't exist yet. `implementer` must
 * add `ArtifactsModule` (imported by `AppModule`) to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   POST /workspaces/:workspaceId/artifacts
 *     body: { prompt: string (1..4000), artifactType: 'presentation'|
 *            'dashboard'|'page'|'report', themePreset: 'kurumsal'|'canli'|
 *            'minimal' } (`.strict()` — unknown keys rejected)
 *     -> 201 { object: <ObjectWithFieldValues> } on success -- 201, not 200,
 *        mirroring `ObjectsController.create`'s own status code for "this
 *        creates a new Lumina Object" (NOT `CommandsController.parse`'s 200,
 *        which never creates anything synchronously itself).
 *     -> 400 on a malformed body (missing `prompt`, invalid `artifactType`/
 *        `themePreset` enum value, unknown extra key).
 *     -> 401 when unauthenticated (no session cookie).
 *     -> RBAC (ADR-0041 Karar g): guarded ONLY by `SessionAuthGuard` +
 *        `WorkspaceMembershipGuard` — NO additional role gate beyond plain
 *        membership (verified directly against
 *        `WorkspaceMembershipService.assertMembership`, which accepts ANY
 *        role, including `guest`). A `guest`-role member's request must
 *        still succeed (201), same as `CommandsController.parse`'s own
 *        RBAC gate.
 *
 * Regression (ADR-0041 §h's "GET/query routes are inherited for free" claim,
 * CORRECTED per this PR's own caller instructions -- the ADR's own claim of
 * a `GET .../objects?type=artifact` filter is WRONG, no such query param
 * exists; the REAL existing "filter by object type" mechanism is
 * `POST .../objects/query` with a REQUIRED `objectType` field in its body):
 * a freshly-created `artifact` object is immediately visible via
 * `POST /workspaces/:workspaceId/objects/query` with
 * `{ objectType: 'artifact', filters: [] }`, with ZERO code changes to
 * `objects.controller.ts`/`objects.service.ts` (both already exist and are
 * untouched by this PR).
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

/**
 * `AI_PROVIDER`'s production fallback responder (`unconfiguredResponder`,
 * `apps/server/src/ai/ai-provider.module.ts`) is what actually answers every
 * generation call in this test file (no `ANTHROPIC_API_KEY` is configured in
 * any integration test in this repo) -- it echoes back everything after a
 * literal `RETURN:` substring found anywhere in the rendered prompt.
 * `validBody()`'s default `prompt` must therefore embed this marker +
 * schema-valid `ArtifactContent` JSON for a generation to actually succeed
 * (otherwise the responder's generic "not configured" fallback text fails
 * `artifactContentSchema` parsing, and `ArtifactsService.generate` correctly
 * throws `ValidationError` -> 400). Mirrors `artifacts.service.integration.
 * test.ts`'s identical convention.
 */
const RETURN_MARKER = 'RETURN:';

function validGeneratedContentJson(): string {
  return JSON.stringify({
    title: 'Q3 Onboarding Summary',
    sections: [
      { kind: 'heading', text: 'Overview', level: 1 },
      { kind: 'paragraph', text: 'This report summarizes our Q3 onboarding checklist.' },
    ],
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
  return `artifacts-controller-test-user-${String(emailCounter)}@example.com`;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: `${RETURN_MARKER}${validGeneratedContentJson()}`,
    artifactType: 'report',
    themePreset: 'kurumsal',
    ...overrides,
  };
}

describe('POST /workspaces/:workspaceId/artifacts (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
    // Generous -- this file's tests are never ABOUT quota enforcement
    // (that's `./artifacts.service.integration.test.ts`'s own concern).
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
    const workspaceId = await createWorkspace(
      cookie,
      `Artifacts Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  /** Mirrors `../fields/field-definitions-security.integration.test.ts`'s
   * `addMemberWithRole` exactly: inserts a membership row DIRECTLY (there is
   * no invite-flow HTTP endpoint in this codebase yet) so a role OTHER than
   * `owner` can be exercised against a real, cookie-authenticated user. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function artifactsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/artifacts`;
  }

  function queryUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects/query`;
  }

  describe('success path', () => {
    it('returns 201 { object } with all 4 field values populated, for an owner-role member', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody());

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;

      expect(object.type).toBe('artifact');
      expect(object.workspaceId).toBe(workspaceId);
      expect(typeof object.fieldValues.htmlContent).toBe('string');
      expect((object.fieldValues.htmlContent as string).length).toBeGreaterThan(0);
      expect(object.fieldValues.themePreset).toBe('kurumsal');
      expect(object.fieldValues.generationPrompt).toBe(validBody().prompt);
      expect(object.fieldValues.artifactType).toBe('report');
    });

    it('RBAC (ADR-0041 Karar g): a GUEST-role member (the least-privileged role) can still successfully generate an artifact -- no stricter gate than plain membership', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', guestCookie)
        .send(validBody());

      expect(response.status).toBe(201);
      const { object } = response.body as ObjectEnvelope;
      expect(object.type).toBe('artifact');
    });
  });

  describe('validation failures -> 400', () => {
    it('rejects a body missing "prompt"', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const body = validBody();
      delete (body as { prompt?: unknown }).prompt;

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(body);

      expect(response.status).toBe(400);
    });

    it('rejects an invalid "artifactType" enum value', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ artifactType: 'slideshow' }));

      expect(response.status).toBe(400);
    });

    it('rejects an invalid "themePreset" enum value', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ themePreset: 'neon' }));

      expect(response.status).toBe(400);
    });

    it('rejects an unknown extra body key (mass-assignment protection, `.strict()`)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ unexpectedField: 'nope' }));

      expect(response.status).toBe(400);
    });
  });

  describe('authentication/authorization', () => {
    it('returns 401 when the request carries no session cookie at all', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server).post(artifactsUrl(workspaceId)).send(validBody());

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is authenticated but not a member of this workspace', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const { cookie: outsiderCookie } = await registerUser();

      const response = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', outsiderCookie)
        .send(validBody());

      expect(response.status).toBe(403);
    });
  });

  describe('regression: POST .../objects/query already covers artifact objects, with ZERO code changes to objects.controller.ts/objects.service.ts', () => {
    it('a freshly-created artifact object is immediately visible via POST /workspaces/:workspaceId/objects/query with { objectType: "artifact" }', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const prompt = `${RETURN_MARKER}${validGeneratedContentJson()}`;

      const createResponse = await request(server)
        .post(artifactsUrl(workspaceId))
        .set('Cookie', cookie)
        .send(validBody({ prompt }));

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
      expect(found?.fieldValues.generationPrompt).toBe(prompt);
    });
  });
});
