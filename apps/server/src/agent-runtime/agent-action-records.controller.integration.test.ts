import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { objectResource } from '@luminaos/agent-runtime';
import type { Actor } from '@luminaos/shared';

import { AgentActionRecordsService } from './agent-action-records.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { RecordAgentActionInput } from './agent-action-records.service.js';
import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T4 PR1b: server-side HTTP wiring for `AgentActionRecordsController`
 * (`workspaces/:workspaceId/agent-action-records`), per ADR-0038 Karar (e)/(g)
 * and the spec's PR1 Kabul Kriterleri. Mirrors `agent-directory.controller.
 * integration.test.ts`'s exact harness (full Nest app boot via Testcontainers
 * Postgres 16 + Redis 7, real `SessionAuthGuard`/`WorkspaceMembershipGuard`
 * flow, the same `addMemberWithRole` raw-insert-into-`memberships` helper).
 *
 * This controller has NO write route at all (ADR-0038 Karar g: the ledger is
 * written only by internal `AgentActionRecordsService.record()` calls from
 * trusted server code, never HTTP) -- so fixture records are seeded here by
 * resolving the real `AgentActionRecordsService` off the booted Nest app
 * (`app.get(AgentActionRecordsService)`) and calling `record()` directly,
 * the same internal call path PR2/PR3 will use, rather than any HTTP POST.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE:
 *
 * `@Controller('workspaces/:workspaceId/agent-action-records')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level.
 *
 *   GET  /workspaces/:workspaceId/agent-action-records
 *        -> 200 { records: [...] } (requires `member`+, else 403)
 *
 *   GET  /workspaces/:workspaceId/agent-action-records/:id
 *        -> 200 { record } (requires `member`+, else 403)
 *        A non-existent id, OR one belonging to a DIFFERENT workspace -> 404.
 *
 *   No POST/PUT/PATCH/DELETE route exists on this controller at all.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface AgentActionRecordBody {
  id: string;
  workspaceId: string;
  provenance: 'decided' | 'autonomous';
  actor: Actor;
  actionType: string;
  outcome: string;
}

interface AgentActionRecordEnvelope {
  record: AgentActionRecordBody;
}

interface AgentActionRecordListEnvelope {
  records: AgentActionRecordBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `agent-action-records-test-user-${String(emailCounter)}@example.com`;
}

function fixtureInput(actionType: string): RecordAgentActionInput {
  return {
    provenance: 'decided',
    actor: { type: 'user', id: randomUUID() },
    actionType,
    intent: 'Create a follow-up task.',
    rationale: 'The user asked for a follow-up.',
    resources: [objectResource('obj-1')],
    rollbackPlan: {
      kind: 'delete',
      targetResource: objectResource('obj-1'),
      description: 'Delete the created task.',
    },
    outcome: 'succeeded',
    resultRef: objectResource('obj-1'),
    causationEventId: randomUUID(),
    undoesRecordId: null,
  };
}

describe('F3-T4 PR1b: HTTP .../agent-action-records -- read-only Flight Recorder ledger (real Postgres + Redis + HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let agentActionRecordsService: AgentActionRecordsService;

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
    agentActionRecordsService = app.get(AgentActionRecordsService);
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
      .send({ name: `Agent action records test workspace ${String(emailCounter)}` });
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

  function recordsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/agent-action-records`;
  }

  function recordUrl(workspaceId: string, id: string): string {
    return `${recordsUrl(workspaceId)}/${id}`;
  }

  async function seedRecord(workspaceId: string, actionType: string): Promise<string> {
    await agentActionRecordsService.record(workspaceId, fixtureInput(actionType));
    const records = await agentActionRecordsService.list(workspaceId, 'admin');
    const match = records.find((r) => r.actionType === actionType);
    if (!match) {
      throw new Error(`Expected a seeded record with actionType "${actionType}"`);
    }
    return match.id;
  }

  it('1. GET list as a "member" -> 200, returns the seeded record for that workspace', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    await seedRecord(workspaceId, 'listable-http-1');
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server).get(recordsUrl(workspaceId)).set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { records } = response.body as AgentActionRecordListEnvelope;
    expect(records.some((r) => r.actionType === 'listable-http-1')).toBe(true);
    void adminCookie;
  });

  it('2. GET list as a "guest" (below member) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server).get(recordsUrl(workspaceId)).set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('3. GET list unauthenticated -> 401', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server).get(recordsUrl(workspaceId));

    expect(response.status).toBe(401);
  });

  it("4. cross-workspace isolation: a record written for workspace A never appears in workspace B's GET list", async () => {
    const { workspaceId: workspaceIdA } = await registerOwnerWithWorkspace();
    await seedRecord(workspaceIdA, 'only-in-a-http');

    const { cookie: cookieB, workspaceId: workspaceIdB } = await registerOwnerWithWorkspace();
    const response = await request(server).get(recordsUrl(workspaceIdB)).set('Cookie', cookieB);

    expect(response.status).toBe(200);
    const { records } = response.body as AgentActionRecordListEnvelope;
    expect(records.some((r) => r.actionType === 'only-in-a-http')).toBe(false);
  });

  it('5. GET :id as a "member" -> 200, returns the specific record', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const id = await seedRecord(workspaceId, 'gettable-http-1');
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .get(recordUrl(workspaceId, id))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { record } = response.body as AgentActionRecordEnvelope;
    expect(record.id).toBe(id);
    expect(record.actionType).toBe('gettable-http-1');
  });

  it('6. GET :id as a "guest" -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const id = await seedRecord(workspaceId, 'guest-forbidden-http-1');
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server)
      .get(recordUrl(workspaceId, id))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('7. GET :id with a non-existent id -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .get(recordUrl(workspaceId, randomUUID()))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it('8. GET :id with an id belonging to a DIFFERENT workspace -> 404 (not a data leak)', async () => {
    const { workspaceId: workspaceIdA } = await registerOwnerWithWorkspace();
    const idInA = await seedRecord(workspaceIdA, 'cross-workspace-get-http-1');

    const { cookie: cookieB, workspaceId: workspaceIdB } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .get(recordUrl(workspaceIdB, idInA))
      .set('Cookie', cookieB);

    expect(response.status).toBe(404);
  });

  /**
   * ADR-0038 Karar (g)/spec Kabul Kriterleri: the ledger has no write route
   * at all -- this is pinned by STATIC inspection of `AgentActionRecordsController`
   * (only `@Get()`/`@Get(':id')` decorators exist, no `@Post`/`@Put`/`@Patch`/
   * `@Delete`), not an HTTP-behavior assertion here: this app's global
   * `AppErrorFilter` (`@Catch()` with no argument, `app.module.ts`) maps
   * ANY genuinely-unmatched route to a 500 (verified empirically against a
   * totally unrelated bogus path, e.g. `POST /totally-bogus-path-xyz`, which
   * also 500s) rather than Nest's own default 404 handler -- a pre-existing,
   * app-wide behavior unrelated to this controller, out of scope for this PR.
   * The one thing this test CAN safely assert without depending on that
   * unrelated behavior: POST to the collection URL never SUCCEEDS (no 2xx),
   * i.e. there is no working write endpoint here, whatever the exact
   * non-2xx status code this app's routing happens to produce for it.
   */
  it('9. no write route exists: POST to the collection URL never succeeds (no 2xx) -- write is only possible via internal AgentActionRecordsService.record() calls', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(recordsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ actionType: 'should-not-be-writable' });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
