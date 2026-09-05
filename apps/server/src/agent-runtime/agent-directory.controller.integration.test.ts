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
 * F3-T3 PR1 (RED step): server-side HTTP wiring for `AgentDirectoryController`
 * (`workspaces/:workspaceId/agents`), per ADR-0037 Karar (b)/(d) and the
 * spec's PR1 Kabul Kriterleri (`docs/specs/F3-E1/F3-T3-ajan-insan-
 * etkilesimi.md`). Mirrors `agent-permission-manifests.controller.
 * integration.test.ts`'s exact harness (full Nest app boot via Testcontainers
 * Postgres 16 + Redis 7, real `SessionAuthGuard`/`WorkspaceMembershipGuard`
 * flow, the same `addMemberWithRole` raw-insert-into-`memberships` helper) --
 * this controller's RBAC is likewise flat/workspace-wide (`admin`+ writes,
 * `member`+ reads), the same shape as `AgentPermissionManifestsController`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `AgentDirectoryService` / `AgentDirectory
 * Projection` / `db/schema/agents.ts` / migration `0039_little_meltdown.sql`
 * already exist and are wired into `AgentRuntimeModule`'s `providers`, but NO
 * `AgentDirectoryController` exists yet, and `AgentRuntimeModule.controllers`
 * does not list one -- every request below to `/workspaces/:workspaceId/
 * agents...` is expected to 404 via Nest's own default "Cannot POST/GET/
 * DELETE ..." handler (no matching route at all), NOT via `AppErrorFilter`
 * mapping an `AppError`, mirroring `agent-permission-manifests.controller.
 * integration.test.ts`'s own documented red-state note for the analogous
 * "controller doesn't exist yet" situation. This file deliberately does NOT
 * statically import `AgentDirectoryService`/the `agents` schema module,
 * staying purely black-box/HTTP for this reason; every assertion below is
 * against HTTP response bodies only.
 *
 * `implementer` must: add `agent-directory.controller.ts` (guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level, calling
 * the already-implemented `AgentDirectoryService.register/.list/.deactivate`)
 * and register it in `AgentRuntimeModule.controllers`. No new DTO/schema file
 * is strictly required beyond a minimal `{name, agentIdentifier}` register
 * body validator, but this test file does not pin its exact shape/location --
 * only the wire contract below.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/agents')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level (mirrors
 * `AgentPermissionManifestsController` exactly).
 *
 *   POST   /workspaces/:workspaceId/agents
 *          body: { name: string, agentIdentifier: string }
 *          -> 201 { agent } (requires `admin`+, else 403)
 *          Duplicate `name` (case-insensitive) or `agentIdentifier` against an
 *          existing ACTIVE agent in the same workspace -> 409
 *          (`ConflictError` -> `AppErrorFilter` -> HTTP 409).
 *
 *   GET    /workspaces/:workspaceId/agents
 *          -> 200 { agents: [...] } (requires `member`+, else 403)
 *          Only `lifecycle: 'active'` agents for the workspace.
 *
 *   DELETE /workspaces/:workspaceId/agents/:agentId
 *          -> 204 (requires `admin`+, else 403); soft-deactivates (sets
 *          `lifecycle: 'deactivated'`), mirrors
 *          `AgentPermissionManifestsController`'s exact DELETE status-code
 *          convention (204 No Content). An `agentId` belonging to a
 *          DIFFERENT workspace (or a non-existent one) -> 404
 *          (`NotFoundError` -> `AppErrorFilter` -> HTTP 404), mirroring
 *          `AgentDirectoryService.deactivate`'s own cross-workspace
 *          `NotFoundError` discipline.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface AgentBody {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: string;
}

interface AgentEnvelope {
  agent: AgentBody;
}

interface AgentListEnvelope {
  agents: AgentBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `agent-directory-test-user-${String(emailCounter)}@example.com`;
}

function registerRequestBody(name: string, agentIdentifier: string): Record<string, unknown> {
  return { name, agentIdentifier };
}

describe('F3-T3 PR1 (RED step): HTTP .../agents -- workspace-scoped agent directory register/list/deactivate (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
      .send({ name: `Agent directory test workspace ${String(emailCounter)}` });
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

  function agentsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/agents`;
  }

  function agentUrl(workspaceId: string, agentId: string): string {
    return `${agentsUrl(workspaceId)}/${agentId}`;
  }

  async function registerAgentAsAdmin(
    cookie: string,
    workspaceId: string,
    name: string,
    agentIdentifier: string,
  ): Promise<AgentBody> {
    const response = await request(server)
      .post(agentsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(registerRequestBody(name, agentIdentifier));
    expect(response.status).toBe(201);
    return (response.body as AgentEnvelope).agent;
  }

  it('1. POST as an admin (the workspace owner) registering an agent -> 201, returns the created agent with a generated id and lifecycle active', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(agentsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(registerRequestBody('Research-Bot', 'research-bot-v1'));

    expect(response.status).toBe(201);
    const { agent } = response.body as AgentEnvelope;
    expect(agent.id).toBeDefined();
    expect(typeof agent.id).toBe('string');
    expect(agent.workspaceId).toBe(workspaceId);
    expect(agent.name).toBe('Research-Bot');
    expect(agent.agentIdentifier).toBe('research-bot-v1');
    expect(agent.lifecycle).toBe('active');
    expect(agent.createdAt).toBeDefined();
  });

  it('2. POST as a "member" (not admin) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(agentsUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(registerRequestBody('Should-Not-Register', 'should-not-register'));

    expect(response.status).toBe(403);
  });

  it('3. POST as a "guest" (below member) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server)
      .post(agentsUrl(workspaceId))
      .set('Cookie', guestCookie)
      .send(registerRequestBody('Should-Not-Register', 'should-not-register'));

    expect(response.status).toBe(403);
  });

  it('4. POST with a name colliding (case-insensitive) against an existing ACTIVE agent in the same workspace -> 409', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await registerAgentAsAdmin(cookie, workspaceId, 'Research-Bot', 'research-bot-v1');

    const response = await request(server)
      .post(agentsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(registerRequestBody('research-bot', 'research-bot-v2'));

    expect(response.status).toBe(409);
  });

  it('5. POST with an agentIdentifier colliding against an existing ACTIVE agent in the same workspace (different name) -> 409', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await registerAgentAsAdmin(cookie, workspaceId, 'Research-Bot', 'research-bot-v1');

    const response = await request(server)
      .post(agentsUrl(workspaceId))
      .set('Cookie', cookie)
      .send(registerRequestBody('Support-Bot', 'research-bot-v1'));

    expect(response.status).toBe(409);
  });

  it('6. GET as a "member" (not admin) -> 200, lists registered agents', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    await registerAgentAsAdmin(adminCookie, workspaceId, 'Research-Bot', 'research-bot-v1');

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const response = await request(server).get(agentsUrl(workspaceId)).set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { agents } = response.body as AgentListEnvelope;
    expect(agents.some((a) => a.agentIdentifier === 'research-bot-v1')).toBe(true);
  });

  it('7. GET as a "guest" (below member) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server).get(agentsUrl(workspaceId)).set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('8. GET excludes deactivated agents -- only lifecycle "active" agents are returned', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const keep = await registerAgentAsAdmin(cookie, workspaceId, 'Keep-Bot', 'keep-bot');
    const toDeactivate = await registerAgentAsAdmin(cookie, workspaceId, 'Gone-Bot', 'gone-bot');

    const deleteResponse = await request(server)
      .delete(agentUrl(workspaceId, toDeactivate.id))
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(server).get(agentsUrl(workspaceId)).set('Cookie', cookie);
    expect(listResponse.status).toBe(200);
    const { agents } = listResponse.body as AgentListEnvelope;
    expect(agents.some((a) => a.id === keep.id)).toBe(true);
    expect(agents.some((a) => a.id === toDeactivate.id)).toBe(false);
  });

  it('9. DELETE (deactivate) as a "member" (not admin) -> 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(
      adminCookie,
      workspaceId,
      'Research-Bot',
      'research-bot-v1',
    );
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .delete(agentUrl(workspaceId, agent.id))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(403);
  });

  it('10. DELETE (deactivate) as an admin -> 204', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(
      cookie,
      workspaceId,
      'Research-Bot',
      'research-bot-v1',
    );

    const response = await request(server)
      .delete(agentUrl(workspaceId, agent.id))
      .set('Cookie', cookie);

    expect(response.status).toBe(204);
  });

  it('11. DELETE with an agentId belonging to a DIFFERENT workspace -> 404, and the original workspace agent is left untouched (still active)', async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    const agentInA = await registerAgentAsAdmin(
      cookieA,
      workspaceAId,
      'Research-Bot',
      'research-bot-v1',
    );

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .delete(agentUrl(workspaceBId, agentInA.id))
      .set('Cookie', cookieB);
    expect(response.status).toBe(404);

    const listInA = await request(server).get(agentsUrl(workspaceAId)).set('Cookie', cookieA);
    const { agents: agentsInA } = listInA.body as AgentListEnvelope;
    const stillActive = agentsInA.find((a) => a.id === agentInA.id);
    expect(stillActive).toBeDefined();
    expect(stillActive?.lifecycle).toBe('active');
  });

  it("12. cross-workspace isolation: an agent registered in workspace A never appears in workspace B's GET", async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    await registerAgentAsAdmin(cookieA, workspaceAId, 'Research-Bot', 'research-bot-v1');

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

    const listInB = await request(server).get(agentsUrl(workspaceBId)).set('Cookie', cookieB);
    expect(listInB.status).toBe(200);
    const { agents: agentsInB } = listInB.body as AgentListEnvelope;
    expect(agentsInB.some((a) => a.agentIdentifier === 'research-bot-v1')).toBe(false);
  });

  it('13. the same name/agentIdentifier used in a DIFFERENT workspace does not conflict (per-workspace uniqueness) -> 201', async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    await registerAgentAsAdmin(cookieA, workspaceAId, 'Research-Bot', 'research-bot-v1');

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();
    const response = await request(server)
      .post(agentsUrl(workspaceBId))
      .set('Cookie', cookieB)
      .send(registerRequestBody('Research-Bot', 'research-bot-v1'));

    expect(response.status).toBe(201);
  });

  it('14. guard stack: unauthenticated caller -> 401 on POST/GET/DELETE', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const postResponse = await request(server)
      .post(agentsUrl(workspaceId))
      .send(registerRequestBody('Anonymous-Bot', 'anonymous-attempt'));
    expect(postResponse.status).toBe(401);

    const getResponse = await request(server).get(agentsUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const deleteResponse = await request(server).delete(agentUrl(workspaceId, 'nonexistent-id'));
    expect(deleteResponse.status).toBe(401);
  });
});
