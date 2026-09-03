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
 * F3-T1 PR2 (RED step): server-side HTTP wiring for
 * `AgentPermissionManifestsController` (`workspaces/:workspaceId/agent-
 * runtime/permission-manifests`), per ADR-0035 Karar (b)/(d)/(i) and the
 * spec's Kabul Kriterleri (`docs/specs/F3-E1/F3-T1-ajan-calisma-zamani.md`).
 * Mirrors `automation-triggers.controller.integration.test.ts`'s exact
 * harness (full Nest app boot via Testcontainers Postgres 16 + Redis 7, real
 * `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, the same
 * `addMemberWithRole` raw-insert-into-`memberships` helper) -- the closest
 * precedent for a controller whose RBAC is flat/workspace-wide (`admin`+
 * writes, `member`+ reads), NOT `MemoryAccessPolicyController`'s self-service-
 * by-`req.user.id` shape (ADR-0035 Karar d's deliberate departure from
 * `MemoryAccessPolicy`'s per-user natural key).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NONE of `AgentPermissionManifestsService` /
 * `AgentPermissionManifestsController` / `AgentPermissionManifestProjection` /
 * an `AgentRuntimeModule` exist yet, and `AppModule` does not import any such
 * module -- every request below to `/workspaces/:workspaceId/agent-runtime/
 * permission-manifests...` is expected to 404 via Nest's own default "Cannot
 * POST/GET/DELETE ..." handler (no matching route at all), NOT via
 * `AppErrorFilter` mapping an `AppError`, mirroring `automation-triggers.
 * controller.integration.test.ts`'s own documented red-state note for the
 * analogous "module doesn't exist yet" situation. `agent_permission_
 * manifests` (schema + migration `0037_*`) is ALSO not yet on disk -- this
 * file deliberately does NOT statically import that schema module (unlike
 * `memory-access-policies.integration.test.ts`'s convention of importing an
 * already-created-in-a-sibling-PR1 schema), staying purely black-box/HTTP
 * for this reason; every assertion below is against HTTP response bodies
 * only.
 *
 * `implementer` must: add `agent-permission-manifests.service.ts` (wrapping
 * `assertValidManifestGrant`/`evaluateManifestGrant` from
 * `@luminaos/agent-runtime`, which must ALSO be added as a new dependency of
 * `apps/server`'s `package.json`), `agent-permission-manifests.controller.ts`,
 * `agent-permission-manifests.projection.ts`, `db/schema/agent-permission-
 * manifests.ts` + migration `0037_*` (up+down), `dto/grant-permission-
 * manifest.schema.ts`, and `agent-runtime.module.ts` (imported by
 * `AppModule`).
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/agent-runtime/permission-manifests')`,
 * guarded by `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class
 * level (mirrors `AutomationTriggersController` exactly).
 *
 *   POST   /workspaces/:workspaceId/agent-runtime/permission-manifests
 *          body: { agentIdentifier, dataScope: {objectTypes: string[] |
 *          'all'}, actionTypes: string[], timeWindow: {startsAt: string |
 *          null, expiresAt: string | null} }
 *          -> 201 { manifest } (requires `admin`+, else 403)
 *          Re-validates via `@luminaos/agent-runtime`'s
 *          `assertValidManifestGrant`, so an empty `actionTypes` array
 *          surfaces as a 400 (`ValidationError` -> `AppErrorFilter` -> HTTP
 *          400), mirroring `AutomationTriggersController`'s unsafe-regex-on-
 *          create -> 400 re-validation contract.
 *
 *   GET    /workspaces/:workspaceId/agent-runtime/permission-manifests
 *          -> 200 { manifests: [...] } (requires `member`+, else 403)
 *          ALL manifests for the workspace, UNFILTERED by `revokedAt` (ADR-
 *          0035's `MemoryAccessPolicy`-derived audit-value convention).
 *
 *   DELETE /workspaces/:workspaceId/agent-runtime/permission-manifests/
 *          :agentIdentifier
 *          -> 204 (requires `admin`+, else 403); soft-revokes (sets
 *          `revokedAt`), never hard-deletes the row -- mirrors
 *          `AutomationTriggersController`'s exact DELETE status-code/body
 *          convention (204 No Content), NOT `MemoryAccessPolicyController`'s
 *          200-with-revoked-policy-body convention.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface ManifestBody {
  id: string;
  workspaceId: string;
  agentIdentifier: string;
  dataScope: { objectTypes: string[] | 'all' };
  actionTypes: string[];
  timeWindow: { startsAt: string | null; expiresAt: string | null };
  grantedAt: string;
  revokedAt: string | null;
}

interface ManifestEnvelope {
  manifest: ManifestBody;
}

interface ManifestListEnvelope {
  manifests: ManifestBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `agent-permission-manifest-test-user-${String(emailCounter)}@example.com`;
}

function grantRequestBody(
  agentIdentifier: string,
  overrides?: {
    actionTypes?: string[];
    dataScope?: { objectTypes: string[] | 'all' };
    timeWindow?: { startsAt: string | null; expiresAt: string | null };
  },
): Record<string, unknown> {
  return {
    agentIdentifier,
    dataScope: overrides?.dataScope ?? { objectTypes: 'all' },
    actionTypes: overrides?.actionTypes ?? ['read-task'],
    timeWindow: overrides?.timeWindow ?? { startsAt: null, expiresAt: null },
  };
}

describe('F3-T1 PR2 (RED step): HTTP .../agent-runtime/permission-manifests -- workspace-scoped agent permission manifest grant/revoke/list (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    await runMigrations(container.getConnectionUri());

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
      .send({ name: `Agent permission manifest test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    const userId = (registerResponse.body as UserEnvelope).user.id;

    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function manifestsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/agent-runtime/permission-manifests`;
  }

  function manifestUrl(workspaceId: string, agentIdentifier: string): string {
    return `${manifestsUrl(workspaceId)}/${agentIdentifier}`;
  }

  async function grantAsAdmin(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<ManifestBody> {
    const response = await request(server)
      .post(manifestsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(body);
    expect(response.status).toBe(201);
    return (response.body as ManifestEnvelope).manifest;
  }

  it('1. POST as an admin (the workspace owner) granting a manifest -> 201, returns the created manifest with a generated id', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(manifestsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(grantRequestBody('summarizer-agent'));

    expect(response.status).toBe(201);
    const { manifest } = response.body as ManifestEnvelope;
    expect(manifest.id).toBeDefined();
    expect(typeof manifest.id).toBe('string');
    expect(manifest.workspaceId).toBe(workspaceId);
    expect(manifest.agentIdentifier).toBe('summarizer-agent');
    expect(manifest.dataScope).toEqual({ objectTypes: 'all' });
    expect(manifest.actionTypes).toEqual(['read-task']);
    expect(manifest.grantedAt).toBeDefined();
    expect(manifest.revokedAt).toBeNull();
  });

  it('2. POST as a "member" (not admin) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(manifestsUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(grantRequestBody('should-not-be-granted'));

    expect(response.status).toBe(403);
  });

  it('3. POST with an invalid grant (empty actionTypes) -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(manifestsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(grantRequestBody('summarizer-agent', { actionTypes: [] }));

    expect(response.status).toBe(400);
  });

  it('4. GET as a "member" (not admin) -> 200, lists granted manifests', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    await grantAsAdmin(adminCookie, workspaceId, grantRequestBody('summarizer-agent'));

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const response = await request(server)
      .get(manifestsUrl(workspaceId))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { manifests } = response.body as ManifestListEnvelope;
    expect(manifests.some((m) => m.agentIdentifier === 'summarizer-agent')).toBe(true);
  });

  it('5. GET as a "guest" (below member) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server)
      .get(manifestsUrl(workspaceId))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('6. DELETE (revoke) as a "member" (not admin) -> 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    await grantAsAdmin(adminCookie, workspaceId, grantRequestBody('summarizer-agent'));
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .delete(manifestUrl(workspaceId, 'summarizer-agent'))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(403);
  });

  it('7. DELETE (revoke) as an admin -> 204, and a subsequent GET still lists the manifest (unfiltered) with revokedAt set', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grantAsAdmin(cookie, workspaceId, grantRequestBody('summarizer-agent'));

    const deleteResponse = await request(server)
      .delete(manifestUrl(workspaceId, 'summarizer-agent'))
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(server).get(manifestsUrl(workspaceId)).set('Cookie', cookie);
    expect(listResponse.status).toBe(200);
    const { manifests } = listResponse.body as ManifestListEnvelope;
    const revoked = manifests.find((m) => m.agentIdentifier === 'summarizer-agent');
    expect(revoked).toBeDefined();
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("8. cross-workspace isolation: a manifest granted in workspace A never appears in workspace B's GET, and a DELETE from workspace B does not affect it", async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    await grantAsAdmin(cookieA, workspaceAId, grantRequestBody('summarizer-agent'));

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

    const listInB = await request(server).get(manifestsUrl(workspaceBId)).set('Cookie', cookieB);
    expect(listInB.status).toBe(200);
    const { manifests: manifestsInB } = listInB.body as ManifestListEnvelope;
    expect(manifestsInB.some((m) => m.agentIdentifier === 'summarizer-agent')).toBe(false);

    await request(server)
      .delete(manifestUrl(workspaceBId, 'summarizer-agent'))
      .set('Cookie', cookieB);

    const listInA = await request(server).get(manifestsUrl(workspaceAId)).set('Cookie', cookieA);
    const { manifests: manifestsInA } = listInA.body as ManifestListEnvelope;
    const stillActive = manifestsInA.find((m) => m.agentIdentifier === 'summarizer-agent');
    expect(stillActive).toBeDefined();
    expect(stillActive?.revokedAt).toBeNull();
  });

  it('9. guard stack: unauthenticated caller -> 401 on POST/GET/DELETE', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const postResponse = await request(server)
      .post(manifestsUrl(workspaceId))
      .send(grantRequestBody('anonymous-attempt'));
    expect(postResponse.status).toBe(401);

    const getResponse = await request(server).get(manifestsUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const deleteResponse = await request(server).delete(
      manifestUrl(workspaceId, 'anonymous-attempt'),
    );
    expect(deleteResponse.status).toBe(401);
  });
});
