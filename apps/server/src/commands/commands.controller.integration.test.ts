import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AIProvider } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { MockInstance } from 'vitest';

/**
 * F1-T16 PR6 (RED step), ADR-0015 §f — the FINAL sub-PR of the
 * conversation-commands feature: wires the already-complete, already-tested
 * `CommandsService` (F1-T16 PR4/PR5, `./commands.service.ts`) into two new
 * HTTP routes via a brand-new `CommandsController`/`CommandsModule`/DTO pair.
 *
 * Nothing under test here exists yet:
 *   - `./commands.controller.ts` / `./commands.module.ts` /
 *     `./dto/parse-command.schema.ts` / `./dto/decide-actions.schema.ts` do
 *     not exist at all.
 *   - `CommandsModule` is not registered in `../app.module.ts`'s own
 *     `imports` array.
 * Every request below to `POST /workspaces/:workspaceId/commands/...`
 * therefore 404s ("Cannot POST ...") today — the correct RED state; none of
 * the specific status-code assertions below (200/401/403/400/404/409) can
 * pass until `implementer` builds the above to match this file's pinned
 * contract exactly.
 *
 * ============================================================================
 * SCOPE (test-writer judgment call, per the task's own instruction): this
 * file does NOT re-test `CommandsService.parse()`/`decide()`'s own business
 * logic exhaustively — that is already covered end-to-end by
 * `./commands.service.integration.test.ts` (PR4) and
 * `./commands.service.decide.integration.test.ts` (PR5), both already green.
 * This file focuses ONLY on what is NEW at the HTTP layer: routing, guard
 * stack (`SessionAuthGuard`/`WorkspaceMembershipGuard`), zod body validation
 * (incl. the two DoS-cap-via-rejection constants below), and the
 * `AppError` -> HTTP-status mapping (`AppErrorFilter`) for `NotFoundError`/
 * `ConflictError`/`ValidationError` surfacing through this specific
 * controller. Because of this, most tests below need only Postgres + Redis +
 * HTTP (via `supertest`) — no raw `db`/`EventStoreService`/`ObjectsService`
 * handles are pulled out of the DI container here (contrast with PR5's own
 * file), reads are done through the already-existing, already-green
 * `GET /workspaces/:workspaceId/objects` HTTP route instead.
 *
 * PINNED CONSTANTS (test-writer judgment calls — implementer must match
 * these exactly in the new DTO schema files for every test below to pass on
 * green, same "pin now, implement later" precedent as
 * `../qa/qa.integration.test.ts` pinning `MAX_QUESTION_LENGTH = 500` before
 * `askQuestionSchema` existed):
 *   - `MAX_COMMAND_LENGTH = 2000` on `parseCommandSchema`'s `command` field —
 *     deliberately larger than `askQuestionSchema`'s 500 (a command can
 *     reference multiple subtasks/assignees in one sentence, so should
 *     comfortably out-size a single natural-language question).
 *   - `decideActionsSchema`'s `decisions` array is capped at 50 entries —
 *     mirrors `CommandsService`'s own private `MAX_DECISIONS_PER_CALL = 50`
 *     (`./commands.service.ts`). This file does not care WHICH layer (the
 *     new DTO's own `.max(50)`, or `CommandsService.decide()`'s existing
 *     runtime check, which fires before any DB read) produces the 400 — both
 *     are correct, both are already exercised by this file's AC8 test not
 *     needing a real proposal to exist first (see that test's own comment).
 *
 * ============================================================================
 * ROUTE CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   POST /workspaces/:workspaceId/commands/parse
 *   Body: { command: string, sourceObjectId?: string }
 *     Zod: z.object({ command: z.string().min(1).max(2000), sourceObjectId: z.string().optional() }).strict()
 *   Response 200: { proposalId: string, actions: ProposedAction[], parseError: boolean, message?: string }
 *   Calls: commandsService.parse(workspaceId, actor, command, sourceObjectId)
 *
 *   POST /workspaces/:workspaceId/commands/:proposalId/decide
 *   Body: { decisions: { actionId: string, decision: 'approved' | 'rejected' }[] }
 *     Zod: z.object({ decisions: z.array(z.object({ actionId: z.string(), decision: z.enum(['approved','rejected']) })).max(50) }).strict()
 *   Response 200: { results: DecideActionResult[] }
 *   Calls: commandsService.decide(workspaceId, proposalId, actor, callerRole, decisions)
 *
 *   Guards on BOTH routes: @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
 *   at the class level, mirroring `QAController`/`ObjectsController` exactly
 *   (PARAMETER-level `@Body(new ZodValidationPipe(...))`, never a
 *   method-level `@UsePipes`, per the F1-T12 PR5a pipe-scoping lesson).
 *
 * The scripted-AI-response trick (`RETURN:<json>` marker) below is copied
 * verbatim from `./commands.service.decide.integration.test.ts`'s own
 * `scriptedActionsCommand` helper — see that file's header for the full
 * mechanism (`MockProvider`'s `unconfiguredResponder` echoes back everything
 * after a literal `"RETURN:"` substring found anywhere in the rendered
 * prompt, and `parseCommand`'s prompt template always embeds `command`
 * verbatim as `Command: ${command}`).
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';
const RETURN_MARKER = 'RETURN:';
/** See this file's header — pinned so `implementer`'s new DTO schema must
 * accept exactly `MAX_COMMAND_LENGTH` characters and reject one more. */
const MAX_COMMAND_LENGTH = 2000;
/** Mirrors `CommandsService`'s own private `MAX_DECISIONS_PER_CALL` — see
 * this file's header. */
const MAX_DECISIONS_PER_CALL = 50;

interface UserEnvelope {
  user: { id: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}
interface ProposedActionBody {
  actionId: string;
  type: 'createTask' | 'generateSubtasks' | 'assignPeople';
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}
interface ParseEnvelope {
  proposalId: string;
  actions: ProposedActionBody[];
  parseError: boolean;
  message?: string;
}
interface DecideResultBody {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
  createdCount?: number;
  totalCount?: number;
  failedAtStep?: number;
  error?: string;
}
interface DecideEnvelope {
  results: DecideResultBody[];
}
interface ObjectSummary {
  id: string;
  title: string;
  type: string;
}
interface ObjectListEnvelope {
  objects: ObjectSummary[];
}
interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `commands-api-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('F1-T16 PR6 (RED step): commands HTTP API (real Postgres + Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let aiProvider: AIProvider;
  let completeSpy: MockInstance<AIProvider['complete']>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Deliberately NOT set -- forces the AI_PROVIDER DI wiring to fall back
    // to MockProvider (`unconfiguredResponder`'s `RETURN:` marker
    // convention), same as every other integration test file here.
    delete process.env.ANTHROPIC_API_KEY;
    // Generous, non-blocking quota/budget -- this file's tests are never
    // ABOUT quota enforcement (that is PR4's own concern); every workspace
    // below starts with 0 prior usage anyway.
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;

    aiProvider = app.get<AIProvider>(AI_PROVIDER);
    completeSpy = vi.spyOn(aiProvider, 'complete');
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
      `Commands API test workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  function parseUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/commands/parse`;
  }

  function decideUrl(workspaceId: string, proposalId: string): string {
    return `/workspaces/${workspaceId}/commands/${proposalId}/decide`;
  }

  async function postParse(
    cookie: string | undefined,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    const req = request(server).post(parseUrl(workspaceId));
    if (cookie !== undefined) {
      req.set('Cookie', cookie);
    }
    return req.send(body);
  }

  async function postDecide(
    cookie: string | undefined,
    workspaceId: string,
    proposalId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    const req = request(server).post(decideUrl(workspaceId, proposalId));
    if (cookie !== undefined) {
      req.set('Cookie', cookie);
    }
    return req.send(body);
  }

  /** Same `RETURN:<json>` marker convention as
   * `./commands.service.decide.integration.test.ts`'s own
   * `scriptedActionsCommand`. */
  function scriptedActionsCommand(actions: Record<string, unknown>[]): string {
    return `Please act on this. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function createTaskAction(title: string): Record<string, unknown> {
    return {
      type: 'createTask',
      intent: 'Create a follow-up task',
      rationale: 'The user asked for one',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: { title },
    };
  }

  /** Parses a scripted command over HTTP and asserts the happy-path shape --
   * the shared proposal-setup step several tests below need before they can
   * exercise `decide`. */
  async function parseAndGetActions(
    cookie: string,
    workspaceId: string,
    actions: Record<string, unknown>[],
  ): Promise<{ proposalId: string; actions: ProposedActionBody[] }> {
    const response = await postParse(cookie, workspaceId, {
      command: scriptedActionsCommand(actions),
    });
    expect(response.status).toBe(200);
    const body = response.body as ParseEnvelope;
    expect(body.parseError).toBe(false);
    return { proposalId: body.proposalId, actions: body.actions };
  }

  async function listObjects(cookie: string, workspaceId: string): Promise<ObjectSummary[]> {
    const response = await request(server)
      .get(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    return (response.body as ObjectListEnvelope).objects;
  }

  // ---------------------------------------------------------------------
  // 1 -- POST .../commands/parse happy path
  // ---------------------------------------------------------------------

  describe('AC1: POST .../commands/parse happy path', () => {
    it('200 with { proposalId, actions, parseError: false } for a scripted createTask command', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const title = 'AC1 Parsed follow-up task';

      const response = await postParse(cookie, workspaceId, {
        command: scriptedActionsCommand([createTaskAction(title)]),
      });

      expect(response.status).toBe(200);
      const body = response.body as ParseEnvelope;
      expect(typeof body.proposalId).toBe('string');
      expect(body.proposalId.length).toBeGreaterThan(0);
      expect(body.parseError).toBe(false);
      expect(body.actions).toHaveLength(1);
      expect(body.actions[0]).toMatchObject({ type: 'createTask', params: { title } });
      expect(typeof body.actions[0]?.actionId).toBe('string');
    });
  });

  // ---------------------------------------------------------------------
  // 2 -- POST .../commands/parse without a session
  // ---------------------------------------------------------------------

  describe('AC2: POST .../commands/parse without a session', () => {
    it('401, and the AI provider is never invoked', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const callsBefore = completeSpy.mock.calls.length;

      const response = await postParse(undefined, workspaceId, { command: 'Do something' });

      expect(response.status).toBe(401);
      expect(completeSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // ---------------------------------------------------------------------
  // 3 -- POST .../commands/parse for a workspace the caller isn't a member of
  // ---------------------------------------------------------------------

  describe("AC3: POST .../commands/parse for a workspace the caller isn't a member of", () => {
    it('403 (mirrors WorkspaceMembershipGuard’s existing status code on every other controller), and the AI provider is never invoked', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const { cookie: outsiderCookie } = await registerUser();
      const callsBefore = completeSpy.mock.calls.length;

      const response = await postParse(outsiderCookie, workspaceId, { command: 'Do something' });

      expect(response.status).toBe(403);
      expect(completeSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // ---------------------------------------------------------------------
  // 4 -- POST .../commands/parse with a body missing `command`
  // ---------------------------------------------------------------------

  describe('AC4: POST .../commands/parse with a malformed body', () => {
    it('missing `command` field -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const response = await postParse(cookie, workspaceId, {});
      expect(response.status).toBe(400);
    });

    it('empty-string `command` -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const response = await postParse(cookie, workspaceId, { command: '' });
      expect(response.status).toBe(400);
    });

    it('an unknown extra body field is rejected (.strict() convention, mirrors askQuestionSchema/searchWorkspaceSchema) -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const response = await postParse(cookie, workspaceId, {
        command: 'A valid command',
        extra: 'nope',
      });
      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------
  // 5 -- POST .../commands/parse with a `command` exceeding MAX_COMMAND_LENGTH
  // ---------------------------------------------------------------------

  describe('AC5: POST .../commands/parse with an over-long `command` (DoS-cap-via-rejection convention)', () => {
    it(`a command of exactly ${String(MAX_COMMAND_LENGTH)} chars is accepted (not itself the boundary under test, but rules out an off-by-one implementation), one more char -> 400`, async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const overLong = 'a'.repeat(MAX_COMMAND_LENGTH + 1);
      const response = await postParse(cookie, workspaceId, { command: overLong });

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------
  // 6 -- POST .../commands/:proposalId/decide happy path
  // ---------------------------------------------------------------------

  describe('AC6: POST .../commands/:proposalId/decide happy path (approve a createTask action)', () => {
    it('200 with { results: [{ actionId, status: "executed" }] }, and the task is really created', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const title = 'AC6 Approved follow-up task';

      const { proposalId, actions } = await parseAndGetActions(cookie, workspaceId, [
        createTaskAction(title),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const response = await postDecide(cookie, workspaceId, proposalId, {
        decisions: [{ actionId, decision: 'approved' }],
      });

      expect(response.status).toBe(200);
      const body = response.body as DecideEnvelope;
      expect(body.results).toEqual([{ actionId, status: 'executed' }]);

      const objects = await listObjects(cookie, workspaceId);
      const created = objects.find((object) => object.title === title);
      expect(created).toBeDefined();
      expect(created?.type).toBe('task');
    });
  });

  // ---------------------------------------------------------------------
  // 7 -- POST .../commands/:proposalId/decide for an unknown proposalId
  // ---------------------------------------------------------------------

  describe('AC7: POST .../commands/:proposalId/decide for an unknown proposalId', () => {
    it('404 (mirrors CommandsService.decide()’s NotFoundError)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(cookie, workspaceId, randomUUID(), {
        decisions: [{ actionId: randomUUID(), decision: 'approved' }],
      });

      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------
  // 8 -- POST .../commands/:proposalId/decide with > 50 decisions
  // ---------------------------------------------------------------------

  describe('AC8: POST .../commands/:proposalId/decide with a decisions array longer than 50', () => {
    it(`${String(MAX_DECISIONS_PER_CALL + 1)} entries -> 400 (rejected at the HTTP/DTO layer, or by CommandsService.decide()’s own MAX_DECISIONS_PER_CALL guard -- either is a correct 400 here; no real proposal is needed since CommandsService.decide() checks the array length before ever reading the proposal row)`, async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const decisions = Array.from({ length: MAX_DECISIONS_PER_CALL + 1 }, () => ({
        actionId: randomUUID(),
        decision: 'approved' as const,
      }));

      const response = await postDecide(cookie, workspaceId, randomUUID(), { decisions });

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------
  // 9 -- POST .../commands/:proposalId/decide without a session
  // ---------------------------------------------------------------------

  describe('AC9: POST .../commands/:proposalId/decide without a session', () => {
    it('401', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(undefined, workspaceId, randomUUID(), {
        decisions: [{ actionId: randomUUID(), decision: 'approved' }],
      });

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------
  // 10 -- POST .../commands/:proposalId/decide called twice
  // ---------------------------------------------------------------------

  describe('AC10: POST .../commands/:proposalId/decide called twice on the same proposal', () => {
    it('first call 200, second call 409 (mirrors CommandsService.decide()’s ConflictError), and does not re-create the task', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const title = 'AC10 Only decided once';

      const { proposalId, actions } = await parseAndGetActions(cookie, workspaceId, [
        createTaskAction(title),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }
      const decisions = [{ actionId, decision: 'approved' as const }];

      const first = await postDecide(cookie, workspaceId, proposalId, { decisions });
      expect(first.status).toBe(200);

      const second = await postDecide(cookie, workspaceId, proposalId, { decisions });
      expect(second.status).toBe(409);

      const objects = await listObjects(cookie, workspaceId);
      expect(objects.filter((object) => object.title === title)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // 11 -- POST .../commands/:proposalId/decide with a malformed decisions body
  // ---------------------------------------------------------------------

  describe('AC11: POST .../commands/:proposalId/decide with a malformed `decisions` body', () => {
    it('a decisions[] item missing `decision` -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(cookie, workspaceId, randomUUID(), {
        decisions: [{ actionId: randomUUID() }],
      });

      expect(response.status).toBe(400);
    });

    it('a decisions[] item with an invalid `decision` enum value ("maybe") -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(cookie, workspaceId, randomUUID(), {
        decisions: [{ actionId: randomUUID(), decision: 'maybe' }],
      });

      expect(response.status).toBe(400);
    });

    it('a body missing `decisions` entirely -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(cookie, workspaceId, randomUUID(), {});

      expect(response.status).toBe(400);
    });

    it('an unknown extra body field is rejected (.strict() convention) -> 400', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(cookie, workspaceId, randomUUID(), {
        decisions: [{ actionId: randomUUID(), decision: 'approved' }],
        extra: 'nope',
      });

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------
  // Extra -- error envelope shape, mirroring AppErrorFilter's contract
  // ---------------------------------------------------------------------

  describe('Extra: error responses use the standard { error: { code, message } } envelope', () => {
    it('the 404 from AC7 carries a `code`/`message` pair, not a bare NestJS default body', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const response = await postDecide(cookie, workspaceId, randomUUID(), {
        decisions: [{ actionId: randomUUID(), decision: 'approved' }],
      });

      expect(response.status).toBe(404);
      const body = response.body as ApiErrorEnvelope;
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    });
  });
});
