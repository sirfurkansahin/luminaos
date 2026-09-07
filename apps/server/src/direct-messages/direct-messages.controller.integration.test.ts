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
 * F3-T3 PR5 (RED step): server-side HTTP wiring for
 * `DirectMessagesController` (`workspaces/:workspaceId/agents/
 * :agentIdentifier/dm`), per ADR-0037 §4 and the spec's PR5 Kabul
 * Kriterleri (`docs/specs/F3-E1/F3-T3-ajan-insan-etkilesimi.md`). Mirrors
 * `agent-directory.controller.integration.test.ts`'s exact harness (full
 * Nest app boot via Testcontainers Postgres 16 + Redis 7, real
 * `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, the same
 * `addMemberWithRole` raw-insert-into-`memberships` helper, and the same
 * `registerAgentAsAdmin`-style HTTP helper against the already-existing
 * `POST /workspaces/:workspaceId/agents` route to seed a real active agent
 * before exercising the new DM routes).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `DirectMessagesService` / `DirectMessagesController`
 * / `DirectMessagesModule` / `db/schema/dm-messages.ts` do not exist yet, and
 * `AppModule` does not import any such module -- every request below to
 * `/workspaces/:workspaceId/agents/:agentIdentifier/dm` is expected to 404 via
 * Nest's own default "Cannot POST/GET ..." handler (no matching route at
 * all), NOT via `AppErrorFilter` mapping an `AppError`, mirroring
 * `agent-directory.controller.integration.test.ts`'s own documented red-state
 * note for the analogous "controller doesn't exist yet" situation. This file
 * deliberately does NOT statically import `DirectMessagesService`/the
 * `dm_messages` schema module, staying purely black-box/HTTP for this reason
 * -- every assertion below is against HTTP response bodies only.
 *
 * `implementer` must: add `direct-messages.service.ts` /
 * `direct-messages.controller.ts` / `direct-messages.module.ts` (importing
 * `CommandsModule`, per the plan's own explicit instruction -- NOT importing
 * `CommandsService` directly, since `CommandsModule` already exports it) /
 * `dto/send-dm-message.schema.ts` / `db/schema/dm-messages.ts` + a migration,
 * and register `DirectMessagesModule` in `AppModule`'s own `imports` array.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/agents/:agentIdentifier/dm')`,
 * guarded by `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class
 * level (mirrors `AgentDirectoryController` exactly).
 *
 *   POST   /workspaces/:workspaceId/agents/:agentIdentifier/dm
 *          body: { body: string } (zod `.strict()`, `body: z.string().min(1).max(4000)`)
 *          -> 201 { userMessage, agentReply } (requires `member`+, else 403)
 *          Calls `send()` with the caller's own actor/userId (`req.user.id`).
 *          A `member` (below `admin`) caller still gets 201 -- `send()`
 *          itself never rejects for this case; only the underlying
 *          `CommandsService.proposeFromDirectMessage` admin-gate is
 *          triggered internally and turned into a polite `agentReply`, never
 *          a 403 at this HTTP layer.
 *          A nonexistent/deactivated `:agentIdentifier` -> 404
 *          (`NotFoundError` -> `AppErrorFilter` -> HTTP 404).
 *
 *   GET    /workspaces/:workspaceId/agents/:agentIdentifier/dm
 *          optional `?userId=` query param (admin-only cross-user read;
 *          defaults to the caller's own `req.user.id` when omitted)
 *          -> 200 { messages: [...] } (requires `member`+, else 403)
 *          `?userId=<someone else>` as a non-admin -> 403.
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
  agentIdentifier: string;
}

interface AgentEnvelope {
  agent: AgentBody;
}

interface DmMessageBody {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  sender: 'user' | 'agent';
  body: string;
  proposalId: string | null;
  createdAt: string;
}

interface SendDmEnvelope {
  userMessage: DmMessageBody;
  agentReply: DmMessageBody;
}

interface ListDmEnvelope {
  messages: DmMessageBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `direct-messages-test-user-${String(emailCounter)}@example.com`;
}

describe('F3-T3 PR5 (RED step): HTTP .../agents/:agentIdentifier/dm -- 1:1 user<->agent DM thread (real Postgres + Redis via Testcontainers + supertest)', () => {
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

    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

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
      .send({ name: `Direct messages test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    const userId = (registerResponse.body as UserEnvelope).user.id;

    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  async function registerAgentAsAdmin(
    cookie: string,
    workspaceId: string,
    name: string,
    agentIdentifier: string,
  ): Promise<AgentBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/agents`)
      .set('Cookie', cookie)
      .send({ name, agentIdentifier });
    expect(response.status).toBe(201);
    return (response.body as AgentEnvelope).agent;
  }

  function dmUrl(workspaceId: string, agentIdentifier: string): string {
    return `/workspaces/${workspaceId}/agents/${agentIdentifier}/dm`;
  }

  it('1. POST without a session cookie -> 401', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(cookie, workspaceId, 'Dm-Bot', 'dm-bot-1');

    const response = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .send({ body: 'Hello agent' });

    expect(response.status).toBe(401);
  });

  it('2. GET without a session cookie -> 401', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(cookie, workspaceId, 'Dm-Bot', 'dm-bot-2');

    const response = await request(server).get(dmUrl(workspaceId, agent.agentIdentifier));

    expect(response.status).toBe(401);
  });

  it('3. POST by an authenticated user who is NOT a member of the workspace -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(ownerCookie, workspaceId, 'Dm-Bot', 'dm-bot-3');

    const { cookie: outsiderCookie } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', outsiderCookie)
      .send({ body: 'Hello agent' });

    expect(response.status).toBe(403);
  });

  it('4. POST as the workspace owner (admin) with a valid body -> 201, returns { userMessage, agentReply }', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(cookie, workspaceId, 'Dm-Bot', 'dm-bot-4');

    const response = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', cookie)
      .send({ body: 'Please grant yourself the answer-question skill' });

    expect(response.status).toBe(201);
    const { userMessage, agentReply } = response.body as SendDmEnvelope;
    expect(userMessage.sender).toBe('user');
    expect(userMessage.body).toBe('Please grant yourself the answer-question skill');
    expect(userMessage.agentIdentifier).toBe(agent.agentIdentifier);
    expect(agentReply.sender).toBe('agent');
    expect(agentReply.id).not.toBe(userMessage.id);
  });

  it('5. POST as a "member" (not admin) -> STILL 201 -- send() itself is member+, the rejection is carried in agentReply, never a 403 at this layer', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(ownerCookie, workspaceId, 'Dm-Bot', 'dm-bot-5');
    const { cookie: memberCookie } = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', memberCookie)
      .send({ body: 'Please grant yourself more permissions' });

    expect(response.status).toBe(201);
    const { agentReply } = response.body as SendDmEnvelope;
    expect(agentReply.proposalId).toBeNull();
  });

  it('6. POST as a "guest" (below member) -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(ownerCookie, workspaceId, 'Dm-Bot', 'dm-bot-6');
    const { cookie: guestCookie } = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', guestCookie)
      .send({ body: 'Hello agent' });

    expect(response.status).toBe(403);
  });

  it('7. POST with an empty body -> 400 (zod validation)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(cookie, workspaceId, 'Dm-Bot', 'dm-bot-7');

    const response = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', cookie)
      .send({ body: '' });

    expect(response.status).toBe(400);
  });

  it('8. POST targeting a nonexistent agentIdentifier -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(dmUrl(workspaceId, 'nonexistent-agent'))
      .set('Cookie', cookie)
      .send({ body: 'Hello agent' });

    expect(response.status).toBe(404);
  });

  it("9. GET without ?userId defaults to the caller's own thread -> 200, includes the message just sent", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(cookie, workspaceId, 'Dm-Bot', 'dm-bot-9');

    const sendResponse = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', cookie)
      .send({ body: 'Hello agent, self-thread check' });
    expect(sendResponse.status).toBe(201);
    const { userMessage } = sendResponse.body as SendDmEnvelope;

    const listResponse = await request(server)
      .get(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const { messages } = listResponse.body as ListDmEnvelope;
    expect(messages.some((m) => m.id === userMessage.id)).toBe(true);
  });

  it('10. GET ?userId=<someone else> as a non-admin member -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(ownerCookie, workspaceId, 'Dm-Bot', 'dm-bot-10');
    const { userId: memberAId } = await addMemberWithRole(workspaceId, 'member');
    const { cookie: memberBCookie } = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .get(`${dmUrl(workspaceId, agent.agentIdentifier)}?userId=${memberAId}`)
      .set('Cookie', memberBCookie);

    expect(response.status).toBe(403);
  });

  it("11. GET ?userId=<someone else> as an admin -> 200, returns that user's thread", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(ownerCookie, workspaceId, 'Dm-Bot', 'dm-bot-11');
    const { cookie: memberCookie, userId: memberId } = await addMemberWithRole(
      workspaceId,
      'member',
    );

    const sendResponse = await request(server)
      .post(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', memberCookie)
      .send({ body: 'Member thread message' });
    expect(sendResponse.status).toBe(201);
    const { userMessage } = sendResponse.body as SendDmEnvelope;

    const listResponse = await request(server)
      .get(`${dmUrl(workspaceId, agent.agentIdentifier)}?userId=${memberId}`)
      .set('Cookie', ownerCookie);

    expect(listResponse.status).toBe(200);
    const { messages } = listResponse.body as ListDmEnvelope;
    expect(messages.some((m) => m.id === userMessage.id)).toBe(true);
  });

  it('12. GET as a "guest" (below member) -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const agent = await registerAgentAsAdmin(ownerCookie, workspaceId, 'Dm-Bot', 'dm-bot-12');
    const { cookie: guestCookie } = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server)
      .get(dmUrl(workspaceId, agent.agentIdentifier))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });
});
