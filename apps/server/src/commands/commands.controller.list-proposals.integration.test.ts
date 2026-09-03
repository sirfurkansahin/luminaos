import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { commandProposals } from '../db/schema/command-proposals.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T16 PR3 (RED step), ADR-0033 §b/§g -- the HTTP layer for
 * `CommandsService.listProposals` (`./commands.service.list-proposals.integration.test.ts`
 * pins the service-level contract; this file focuses ONLY on what is NEW at
 * the HTTP layer: routing, guard stack, query-param parsing, and the
 * response envelope -- mirrors `./commands.controller.integration.test.ts`'s
 * (F1-T16 PR6) own "service logic is tested elsewhere" scoping decision).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `CommandsController` nor
 * `CommandsService` has a `GET /workspaces/:workspaceId/commands/proposals`
 * route -- every request below 404s via Nest's own default "Cannot GET ..."
 * handler (no matching route at all), NOT via `AppErrorFilter` mapping an
 * `AppError`. This is the correct RED state; none of the specific
 * status-code assertions below (200/401/403) can pass until `implementer`
 * adds the route AND `CommandsService.listProposals` itself (see the sibling
 * service-level test file for that contract).
 *
 * Mirrors `../automation/automation-triggers.controller.integration.test.ts`'s
 * exact harness: full Nest app boot via Testcontainers Postgres 16 + Redis 7,
 * real `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, the same
 * `addMemberWithRole` raw-insert-into-`memberships` helper (the only way in
 * this codebase's test suites to get a `member`/`guest` session that isn't
 * the workspace's own `owner`).
 *
 * Fixture proposals are raw-inserted directly into `command_proposals` (via
 * a real `Database` handle pulled out of the same connection string the app
 * itself uses) rather than round-tripped through a scripted-AI `POST
 * .../commands/parse` call -- this file's own judgment call (explicitly
 * allowed by the task): it gives precise, deterministic control over
 * `decidedAt`/ordering for the pagination/pendingOnly tests below without
 * needing to script an AI provider response at all. This technique is
 * already established in this codebase (e.g.
 * `../automation/automation-triggers.controller.integration.test.ts`'s own
 * `rawTriggerRow` raw-Drizzle helper against a different table).
 *
 * ----------------------------------------------------------------------------
 * ROUTE CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   GET /workspaces/:workspaceId/commands/proposals
 *     Query (all optional): ?pendingOnly=true, ?limit=N, ?cursor=<id>
 *     -> 200 { proposals: CommandProposalSummaryBody[], nextCursor?: string }
 *     Guard stack: @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard) at
 *     the class level (already present on `CommandsController`) -- `member`+
 *     required (ADR-0033 §g), else 403; unauthenticated -> 401.
 *     Calls: commandsService.listProposals(workspaceId, callerRole, { pendingOnly, limit, cursor })
 * ----------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}
interface CommandProposalSummaryBody {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: unknown;
  decisions: unknown;
  createdAt: string;
  decidedAt: string | null;
}
interface ListProposalsEnvelope {
  proposals: CommandProposalSummaryBody[];
  nextCursor?: string;
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `list-proposals-api-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('F2-T16 PR3 (RED step): GET .../commands/proposals -- automation history read endpoint (real Postgres + Redis via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let nextSeedCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Deliberately unset -- forces AI_PROVIDER DI to fall back to
    // MockProvider, same as every other integration test file here (this
    // file never calls `POST .../commands/parse` anyway).
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
      `List proposals API test workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function proposalsUrl(workspaceId: string, query?: Record<string, string>): string {
    const base = `/workspaces/${workspaceId}/commands/proposals`;
    if (!query) {
      return base;
    }
    const qs = new URLSearchParams(query).toString();
    return qs ? `${base}?${qs}` : base;
  }

  /** Raw-inserts a `command_proposals` row -- see this file's header for why. */
  async function seedProposal(
    workspaceId: string,
    overrides: {
      id?: string;
      command?: string;
      decisions?: unknown[] | null;
      decidedAt?: Date | null;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    nextSeedCounter += 1;
    // Zero-padded counter keeps ids lexicographically ordered by insertion
    // order (newest = highest counter), without depending on real
    // wall-clock timing -- this file only needs RELATIVE ordering, not a
    // real ULID shape.
    const id = overrides.id ?? `01SEEDPROPOSAL${String(nextSeedCounter).padStart(10, '0')}`;

    await rawDb.insert(commandProposals).values({
      id,
      streamId: randomUUID(),
      workspaceId,
      command: overrides.command ?? `seeded command ${id}`,
      sourceObjectId: null,
      actions: [],
      decisions: overrides.decisions ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      decidedAt: overrides.decidedAt ?? null,
    });

    return id;
  }

  // ---------------------------------------------------------------------
  // AC1 -- happy path as the workspace owner
  // ---------------------------------------------------------------------

  describe('AC1: GET .../commands/proposals as the workspace owner', () => {
    it('200 with { proposals } containing a seeded proposal', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const proposalId = await seedProposal(workspaceId);

      const response = await request(server).get(proposalsUrl(workspaceId)).set('Cookie', cookie);

      expect(response.status).toBe(200);
      const body = response.body as ListProposalsEnvelope;
      expect(body.proposals.some((proposal) => proposal.id === proposalId)).toBe(true);
    });

    it('the response envelope carries the full row shape (id/workspaceId/command/sourceObjectId/actions/decisions/createdAt/decidedAt)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const proposalId = await seedProposal(workspaceId, { command: 'shape check command' });

      const response = await request(server).get(proposalsUrl(workspaceId)).set('Cookie', cookie);

      expect(response.status).toBe(200);
      const body = response.body as ListProposalsEnvelope;
      const found = body.proposals.find((proposal) => proposal.id === proposalId);
      expect(found).toBeDefined();
      expect(found?.workspaceId).toBe(workspaceId);
      expect(found?.command).toBe('shape check command');
      expect(found?.sourceObjectId).toBeNull();
      expect(Array.isArray(found?.actions)).toBe(true);
      expect(found?.decisions).toBeNull();
      expect(typeof found?.createdAt).toBe('string');
      expect(found?.decidedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- RBAC: member+ required (ADR-0033 §g)
  // ---------------------------------------------------------------------

  describe('AC2: RBAC -- member+ required, deliberately DIFFERENT from the webhook-subscriptions admin+ rule (ADR-0033 §g)', () => {
    it('a "guest" -> 403', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const guestCookie = await addMemberWithRole(workspaceId, 'guest');

      const response = await request(server)
        .get(proposalsUrl(workspaceId))
        .set('Cookie', guestCookie);

      expect(response.status).toBe(403);
    });

    it('a "member" (below admin) -> 200 (ADR-0033 §g: CommandsService.listProposals mirrors AutomationTriggersService.list\'s member-read precedent, NOT WebhookSubscriptionsService.list\'s admin+ rule from PR1)', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const proposalId = await seedProposal(workspaceId);
      const memberCookie = await addMemberWithRole(workspaceId, 'member');

      const response = await request(server)
        .get(proposalsUrl(workspaceId))
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
      const body = response.body as ListProposalsEnvelope;
      expect(body.proposals.some((proposal) => proposal.id === proposalId)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- unauthenticated caller
  // ---------------------------------------------------------------------

  describe('AC3: GET .../commands/proposals without a session', () => {
    it('401', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();

      const response = await request(server).get(proposalsUrl(workspaceId));

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- pendingOnly query param
  // ---------------------------------------------------------------------

  describe('AC4: ?pendingOnly=true excludes already-decided proposals', () => {
    it('a decided proposal is excluded, a pending one is included', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const pendingId = await seedProposal(workspaceId, { decidedAt: null });
      const decidedId = await seedProposal(workspaceId, {
        decisions: [{ actionId: 'a1', decision: 'approved' }],
        decidedAt: new Date(),
      });

      const response = await request(server)
        .get(proposalsUrl(workspaceId, { pendingOnly: 'true' }))
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      const body = response.body as ListProposalsEnvelope;
      const ids = body.proposals.map((proposal) => proposal.id);
      expect(ids).toContain(pendingId);
      expect(ids).not.toContain(decidedId);
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- limit + cursor pagination round-trip
  // ---------------------------------------------------------------------

  describe('AC5: ?limit + ?cursor pagination -- newest-first, no overlap/gaps across pages', () => {
    it('a limit smaller than the total row count returns the newest page + a nextCursor; passing that cursor back returns the remaining rows exactly once', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const oldestId = await seedProposal(workspaceId);
      const middleId = await seedProposal(workspaceId);
      const newestId = await seedProposal(workspaceId);

      const firstResponse = await request(server)
        .get(proposalsUrl(workspaceId, { limit: '2' }))
        .set('Cookie', cookie);

      expect(firstResponse.status).toBe(200);
      const firstBody = firstResponse.body as ListProposalsEnvelope;
      expect(firstBody.proposals.map((proposal) => proposal.id)).toEqual([newestId, middleId]);
      expect(firstBody.nextCursor).toBe(middleId);

      const secondResponse = await request(server)
        .get(
          proposalsUrl(workspaceId, {
            limit: '2',
            cursor: firstBody.nextCursor ?? '',
          }),
        )
        .set('Cookie', cookie);

      expect(secondResponse.status).toBe(200);
      const secondBody = secondResponse.body as ListProposalsEnvelope;
      expect(secondBody.proposals.map((proposal) => proposal.id)).toEqual([oldestId]);
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC6 -- cross-workspace isolation
  // ---------------------------------------------------------------------

  describe("AC6: cross-workspace isolation -- a proposal from workspace A is never visible via workspace B's URL, even to workspace B's owner", () => {
    it("workspace B's own GET response never contains workspace A's proposal id", async () => {
      const { workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
      const proposalIdA = await seedProposal(workspaceAId);

      const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

      const response = await request(server).get(proposalsUrl(workspaceBId)).set('Cookie', cookieB);

      expect(response.status).toBe(200);
      const body = response.body as ListProposalsEnvelope;
      expect(body.proposals.some((proposal) => proposal.id === proposalIdA)).toBe(false);
    });
  });
});
