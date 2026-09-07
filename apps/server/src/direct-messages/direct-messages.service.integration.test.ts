import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { MockInstance } from 'vitest';

/**
 * F3-T3 PR5 (RED step), ADR-0037 §4 -- `DirectMessagesService`: a
 * lightweight, event-sourced, persistent 1:1 DM thread per `(workspaceId,
 * userId, agentIdentifier)` that CALLS the already-merged (PR4)
 * `CommandsService.proposeFromDirectMessage` and turns its result into a
 * durable agent reply row. This PR does NOT re-implement any reconfiguration
 * logic -- it is pure plumbing (storage + orchestration) around PR4's
 * already-green `proposeFromDirectMessage`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./direct-messages.service.ts` does not exist
 * at all (nor does `../db/schema/dm-messages.ts`, nor any migration for a
 * `dm_messages` table) -- the dynamic `import('./direct-messages.service.js')`
 * call inside `beforeAll` REJECTS ("Cannot find module"), failing every `it`
 * in this file. This mirrors `agent-directory.service.integration.test.ts`'s
 * own documented "service doesn't exist yet" red state. `AgentDirectoryService`
 * / `CommandsService.proposeFromDirectMessage` (both already real, already
 * green, from earlier PRs) are dynamically imported too, purely to keep this
 * file's whole "domain constructors" resolution symmetric and to avoid ANY
 * risk of a stray static import of `../commands/commands.service.js` (which
 * transitively pulls in `../config/env.ts` via `AIProviderModule`/
 * `AIUsageModule`'s own module-wiring files) running before this file's own
 * `beforeAll` has set `DATABASE_URL`/`REDIS_URL` -- `env.ts`'s top-level
 * `export const env: Env = readEnv()` would otherwise `process.exit(1)` the
 * whole test worker before a single `it` runs. Every file in this repo that
 * touches `CommandsService` (e.g.
 * `../commands/commands.service.propose-from-direct-message.integration.test.ts`)
 * follows this exact same dynamic-import discipline for this exact reason.
 *
 * HARNESS NOTE: mirrors `../commands/commands.service.propose-from-direct-
 * message.integration.test.ts`'s LIGHTWEIGHT harness exactly (Testcontainers
 * Postgres only, no Redis container, no full Nest app boot, no HTTP) --
 * `CommandsService` is manually `new`'d with only the 5 constructor params
 * `proposeFromDirectMessage` itself actually touches
 * (`db`/`eventStore`/`projectionRunner`/`aiUsageService`/`aiProvider`); the
 * other 4 real trailing constructor params (`objectsService`/
 * `relationsService`/`workspaceMembershipService`/
 * `agentPermissionManifestsService`) are only ever read by
 * `executeReconfigureAgentPermissions`/`decide()`, neither of which this PR's
 * `DirectMessagesService.send()` ever calls (it only calls
 * `proposeFromDirectMessage`, never `decide`) -- so they are simply omitted
 * here, exactly like that sibling file already does for the exact same
 * reason. `REDIS_URL` is set to an inert placeholder string (never actually
 * connected to) purely to satisfy `env.ts`'s fail-fast presence check.
 *
 * The scripted-AI-response trick below (`RETURN:<json>` marker) is copied
 * verbatim from `../commands/commands.service.propose-from-direct-
 * message.integration.test.ts`'s own `scriptedDmMessage`/
 * `oneValidReconfigureAction` helpers.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `DirectMessagesService(db, eventStore, projectionRunner, commandsService)`:
 *   - `send(workspaceId, actor, callerRole, agentIdentifier, body):
 *     Promise<{ userMessage: DmMessage; agentReply: DmMessage }>`
 *     - RBAC: `member`+ (else `ForbiddenError`, nothing written).
 *     - Nonexistent/deactivated `agentIdentifier` -> `NotFoundError`, nothing
 *       written (checked BEFORE any event is appended).
 *     - Always durably records the user's own message first
 *       (`sender: 'user'`, `proposalId: null`).
 *     - Calls `commandsService.proposeFromDirectMessage(...)`:
 *       - `ForbiddenError` (non-admin `callerRole`) is CAUGHT -- `send()`
 *         itself never throws for this case -- and an agent reply with the
 *         FIXED rejection string `'Only workspace admins can request agent
 *         permission changes via DM.'` (`proposalId: null`) is recorded. The
 *         AI provider is NEVER invoked in this branch (no quota spent).
 *       - `parseError: true` -> agent reply body is the result's own
 *         `message` (or a fixed fallback), `proposalId: null`.
 *       - `parseError: false` -> agent reply's `proposalId` column is set to
 *         the REAL `proposalId` from the parse result.
 *   - `list(workspaceId, requestingUserId, targetUserId, agentIdentifier,
 *     callerRole): Promise<DmMessage[]>`
 *     - RBAC: `member`+ AND (`requestingUserId === targetUserId` OR
 *       `admin`+) -- else `ForbiddenError`.
 *     - Returns ALL messages (`user` and `agent` rows) for `(workspaceId,
 *       targetUserId, agentIdentifier)`, ordered by `createdAt` ascending.
 * ============================================================================
 */

const RETURN_MARKER = 'RETURN:';
/** Pinned verbatim from this PR's own spec -- see this file's header. */
const NON_ADMIN_REJECTION_BODY =
  'Only workspace admins can request agent permission changes via DM.';

interface ProposedActionContract {
  actionId: string;
  type:
    | 'createTask'
    | 'generateSubtasks'
    | 'assignPeople'
    | 'createTaskFromMeeting'
    | 'createTaskFromTrigger'
    | 'reconfigureAgentPermissions';
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}

interface CommandsServiceParseResult {
  proposalId: string;
  actions: ProposedActionContract[];
  parseError: boolean;
  message?: string;
}

interface AIUsageServiceContract {
  withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
  assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void>;
  assertAICostBudgetNotExceeded(workspaceId: string): Promise<void>;
  recordAIUsage(
    workspaceId: string,
    fieldDefinitionId: string | undefined,
    objectId: string | undefined,
    usage: { inputTokens: number; outputTokens: number },
    model: string,
  ): Promise<void>;
}

type AIUsageServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AIUsageServiceContract;

interface CommandsServiceContract {
  proposeFromDirectMessage(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    agentIdentifier: string,
    dmMessageText: string,
  ): Promise<CommandsServiceParseResult>;
}

type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageServiceContract,
  aiProvider: AIProvider,
) => CommandsServiceContract;

interface AgentContract {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: Date;
}

interface AgentDirectoryServiceLike {
  register(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: { name: string; agentIdentifier: string },
  ): Promise<AgentContract>;
  deactivate(
    workspaceId: string,
    agentId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<AgentContract>;
}

type AgentDirectoryServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AgentDirectoryServiceLike;

interface DmMessageContract {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  sender: 'user' | 'agent';
  body: string;
  proposalId: string | null;
  createdAt: Date;
}

interface DirectMessagesServiceLike {
  send(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    agentIdentifier: string,
    body: string,
  ): Promise<{ userMessage: DmMessageContract; agentReply: DmMessageContract }>;
  list(
    workspaceId: string,
    requestingUserId: string,
    targetUserId: string,
    agentIdentifier: string,
    callerRole: MembershipRole,
  ): Promise<DmMessageContract[]>;
}

type DirectMessagesServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  commandsService: CommandsServiceContract,
) => DirectMessagesServiceLike;

interface RawCommandProposalRow {
  id: string;
  workspace_id: string;
}

describe('F3-T3 PR5 (RED step): DirectMessagesService -- 1:1 user<->agent DM thread (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let agentDirectoryService: AgentDirectoryServiceLike;
  let aiUsageService: AIUsageServiceContract;
  let provider: MockProvider;
  let completeSpy: MockInstance<AIProvider['complete']>;
  let commandsService: CommandsServiceContract;
  let service: DirectMessagesServiceLike;
  let workspaceCounter = 0;
  let agentCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://direct-messages-test-placeholder:6379';
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    const agentDirectoryModule: unknown =
      await import('../agent-runtime/agent-directory.service.js');
    const AgentDirectoryServiceCtor = (
      agentDirectoryModule as { AgentDirectoryService: AgentDirectoryServiceConstructor }
    ).AgentDirectoryService;
    agentDirectoryService = new AgentDirectoryServiceCtor(db, eventStore, projectionRunner);

    const aiUsageModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageModule as { AIUsageService: AIUsageServiceConstructor })
      .AIUsageService;
    aiUsageService = new AIUsageServiceCtor(db, eventStore, projectionRunner);

    function respond(request: AICompletionRequest): AICompletionResult {
      const markerIndex = request.prompt.indexOf(RETURN_MARKER);

      if (markerIndex === -1) {
        throw new Error('Test bug: rendered prompt has no RETURN: marker');
      }

      return {
        text: request.prompt.slice(markerIndex + RETURN_MARKER.length),
        usage: { inputTokens: 50, outputTokens: 10 },
      };
    }

    provider = new MockProvider(respond);
    completeSpy = vi.spyOn(provider, 'complete');

    const commandsModule: unknown = await import('../commands/commands.service.js');
    const CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;
    commandsService = new CommandsServiceCtor(
      db,
      eventStore,
      projectionRunner,
      aiUsageService,
      provider,
    );

    const dmModule: unknown = await import('./direct-messages.service.js');
    const DirectMessagesServiceCtor = (
      dmModule as { DirectMessagesService: DirectMessagesServiceConstructor }
    ).DirectMessagesService;
    service = new DirectMessagesServiceCtor(db, eventStore, projectionRunner, commandsService);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `dm-test-workspace-${String(workspaceCounter)}`,
        slug: `dm-test-workspace-${String(workspaceCounter)}-${crypto.randomUUID()}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  /**
   * CI-only bug fix (F3-T3 PR5): `dm_messages.user_id` carries a REAL FK to
   * `users.id` (mirrors `memory_access_policies.user_id`'s identical FK) --
   * unlike `agents`' actor param (never persisted as an FK), a fabricated
   * `crypto.randomUUID()` actor here fails the insert with a foreign-key
   * violation the moment `DirectMessagesService.send()` tries to record the
   * user's own message. This never surfaced locally (Testcontainers
   * unavailable in the sandbox), only in real CI. Seeds a real `users` row
   * so every actor this file hands to `service.send()`/`.list()` is backed by
   * an FK-satisfying row.
   */
  async function fakeActor(): Promise<Actor> {
    const [row] = await db
      .insert(users)
      .values({
        email: `dm-test-user-${crypto.randomUUID()}@example.com`,
        passwordHash: 'unused-test-hash',
      })
      .returning({ id: users.id });
    if (!row) {
      throw new Error('Failed to create test user');
    }
    return { type: 'user', id: row.id };
  }

  async function registerActiveAgent(workspaceId: string): Promise<string> {
    agentCounter += 1;
    const agentIdentifier = `dm-test-agent-${String(agentCounter)}`;
    await agentDirectoryService.register(workspaceId, await fakeActor(), 'admin', {
      name: `Dm-Test-Agent-${String(agentCounter)}`,
      agentIdentifier,
    });
    return agentIdentifier;
  }

  function scriptedDmMessage(actions: Record<string, unknown>[]): string {
    return `Please grant this agent access to answer questions. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function oneValidReconfigureAction(agentIdentifier: string): Record<string, unknown> {
    return {
      type: 'reconfigureAgentPermissions',
      intent: `Grant the answer-question skill to agent ${agentIdentifier}`,
      rationale: 'The user asked, via DM, to let this agent answer questions',
      resources: [agentIdentifier],
      rollbackNote: 'Revoke the manifest if this was a mistake',
      params: {
        agentIdentifier,
        operation: 'grant',
        dataScope: { objectTypes: 'all' },
        actionTypes: ['answer-question'],
        timeWindow: { startsAt: null, expiresAt: null },
      },
    };
  }

  async function getProposalRow(proposalId: string): Promise<RawCommandProposalRow | undefined> {
    const result = await db.$client.query<RawCommandProposalRow>(
      'select id, workspace_id from command_proposals where id = $1',
      [proposalId],
    );
    return result.rows[0];
  }

  async function countProposalRows(workspaceId: string): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      'select count(*)::text as count from command_proposals where workspace_id = $1',
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // ---------------------------------------------------------------------
  // send() -- happy path (admin caller, valid reconfiguration request)
  // ---------------------------------------------------------------------

  it('1. send() by an admin with a valid reconfiguration DM persists a user message and an agent reply with a real, non-null proposalId', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

    const callsBefore = completeSpy.mock.calls.length;

    const { userMessage, agentReply } = await service.send(
      workspaceId,
      adminActor,
      'admin',
      agentIdentifier,
      dmMessageText,
    );

    expect(completeSpy.mock.calls.length).toBeGreaterThan(callsBefore);

    expect(userMessage.sender).toBe('user');
    expect(userMessage.body).toBe(dmMessageText);
    expect(userMessage.proposalId).toBeNull();
    expect(userMessage.workspaceId).toBe(workspaceId);
    expect(userMessage.userId).toBe(adminActor.id);
    expect(userMessage.agentIdentifier).toBe(agentIdentifier);
    expect(userMessage.id).toBeDefined();
    expect(userMessage.createdAt).toBeDefined();

    expect(agentReply.sender).toBe('agent');
    expect(typeof agentReply.proposalId).toBe('string');
    expect(agentReply.proposalId?.length).toBeGreaterThan(0);
    expect(agentReply.workspaceId).toBe(workspaceId);
    expect(agentReply.userId).toBe(adminActor.id);
    expect(agentReply.agentIdentifier).toBe(agentIdentifier);
    expect(agentReply.id).not.toBe(userMessage.id);

    const proposalRow = await getProposalRow(agentReply.proposalId as string);
    expect(proposalRow).toBeDefined();
    expect(proposalRow?.workspace_id).toBe(workspaceId);
  });

  // ---------------------------------------------------------------------
  // send() -- non-admin caller is politely rejected, no AI spend
  // ---------------------------------------------------------------------

  it('2. send() by a "member" (not admin) still persists the user message, replies with the fixed rejection string (proposalId null), never calls the AI provider, and records no command_proposals row', async () => {
    const workspaceId = await createWorkspace();
    const memberActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

    const callsBefore = completeSpy.mock.calls.length;

    const { userMessage, agentReply } = await service.send(
      workspaceId,
      memberActor,
      'member',
      agentIdentifier,
      dmMessageText,
    );

    expect(completeSpy.mock.calls.length).toBe(callsBefore);
    expect(await countProposalRows(workspaceId)).toBe(0);

    expect(userMessage.sender).toBe('user');
    expect(userMessage.body).toBe(dmMessageText);

    expect(agentReply.sender).toBe('agent');
    expect(agentReply.body).toBe(NON_ADMIN_REJECTION_BODY);
    expect(agentReply.proposalId).toBeNull();

    const thread = await service.list(
      workspaceId,
      memberActor.id,
      memberActor.id,
      agentIdentifier,
      'member',
    );
    expect(thread).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // send() -- unknown / deactivated agent
  // ---------------------------------------------------------------------

  it('3. send() targeting a nonexistent agentIdentifier throws NotFoundError and writes nothing', async () => {
    const workspaceId = await createWorkspace();
    const actor = await fakeActor();
    const callsBefore = completeSpy.mock.calls.length;

    await expect(
      service.send(workspaceId, actor, 'admin', 'nonexistent-agent', 'Hello there'),
    ).rejects.toThrow(NotFoundError);

    expect(completeSpy.mock.calls.length).toBe(callsBefore);
    const thread = await service.list(
      workspaceId,
      actor.id,
      actor.id,
      'nonexistent-agent',
      'admin',
    );
    expect(thread).toHaveLength(0);
  });

  it('3b. send() targeting a DEACTIVATED agentIdentifier throws NotFoundError and writes nothing', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = await fakeActor();
    agentCounter += 1;
    const agentIdentifier = `dm-test-agent-deactivated-${String(agentCounter)}`;
    const agent = await agentDirectoryService.register(workspaceId, adminActor, 'admin', {
      name: `Deactivated-Agent-${String(agentCounter)}`,
      agentIdentifier,
    });
    await agentDirectoryService.deactivate(workspaceId, agent.id, adminActor, 'admin');

    const callsBefore = completeSpy.mock.calls.length;

    await expect(
      service.send(
        workspaceId,
        adminActor,
        'admin',
        agentIdentifier,
        'Please reconfigure yourself',
      ),
    ).rejects.toThrow(NotFoundError);

    expect(completeSpy.mock.calls.length).toBe(callsBefore);
    const thread = await service.list(
      workspaceId,
      adminActor.id,
      adminActor.id,
      agentIdentifier,
      'admin',
    );
    expect(thread).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // send() -- RBAC: member+ required (guest rejected before anything is written)
  // ---------------------------------------------------------------------

  it('4. send() by a "guest" (below member) throws ForbiddenError and writes nothing', async () => {
    const workspaceId = await createWorkspace();
    const guestActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    const callsBefore = completeSpy.mock.calls.length;

    await expect(
      service.send(workspaceId, guestActor, 'guest', agentIdentifier, 'Hello agent'),
    ).rejects.toThrow(ForbiddenError);

    expect(completeSpy.mock.calls.length).toBe(callsBefore);
    const thread = await service.list(
      workspaceId,
      guestActor.id,
      guestActor.id,
      agentIdentifier,
      'admin',
    );
    expect(thread).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // list() -- happy path, chronological order
  // ---------------------------------------------------------------------

  it('5. list() by the thread owner returns both messages in chronological order after send()', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

    const { userMessage, agentReply } = await service.send(
      workspaceId,
      adminActor,
      'admin',
      agentIdentifier,
      dmMessageText,
    );

    const thread = await service.list(
      workspaceId,
      adminActor.id,
      adminActor.id,
      agentIdentifier,
      'admin',
    );

    expect(thread).toHaveLength(2);
    expect(thread[0]?.id).toBe(userMessage.id);
    expect(thread[0]?.sender).toBe('user');
    expect(thread[1]?.id).toBe(agentReply.id);
    expect(thread[1]?.sender).toBe('agent');
    expect(thread[0]?.createdAt.getTime()).toBeLessThanOrEqual(thread[1]?.createdAt.getTime() ?? 0);
  });

  // ---------------------------------------------------------------------
  // list() -- cross-user isolation (a member cannot read someone else's thread)
  // ---------------------------------------------------------------------

  it("6. list() by a different, non-admin member requesting someone else's thread throws ForbiddenError", async () => {
    const workspaceId = await createWorkspace();
    const ownerActor = await fakeActor();
    const otherMemberActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    await service.send(
      workspaceId,
      ownerActor,
      'admin',
      agentIdentifier,
      scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]),
    );

    await expect(
      service.list(workspaceId, otherMemberActor.id, ownerActor.id, agentIdentifier, 'member'),
    ).rejects.toThrow(ForbiddenError);
  });

  // ---------------------------------------------------------------------
  // list() -- admin cross-user read (audit)
  // ---------------------------------------------------------------------

  it("7. list() by an admin requesting a DIFFERENT user's thread succeeds and returns that user's messages", async () => {
    const workspaceId = await createWorkspace();
    const memberActor = await fakeActor();
    const adminActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    const { userMessage, agentReply } = await service.send(
      workspaceId,
      memberActor,
      'member',
      agentIdentifier,
      'Please help me',
    );

    const thread = await service.list(
      workspaceId,
      adminActor.id,
      memberActor.id,
      agentIdentifier,
      'admin',
    );

    expect(thread).toHaveLength(2);
    expect(thread.map((m) => m.id).sort()).toEqual([userMessage.id, agentReply.id].sort());
  });

  // ---------------------------------------------------------------------
  // list() -- cross-workspace isolation
  // ---------------------------------------------------------------------

  it("8. list() scoped to workspace B never returns a thread's messages recorded in workspace A, even with the same userId/agentIdentifier", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const actor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceA);

    await service.send(
      workspaceA,
      actor,
      'admin',
      agentIdentifier,
      scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]),
    );

    const threadInB = await service.list(workspaceB, actor.id, actor.id, agentIdentifier, 'admin');
    expect(threadInB).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // list() -- distinct (userId, agentIdentifier) pairs never leak into each other
  // ---------------------------------------------------------------------

  it('9. two distinct (userId, agentIdentifier) pairs in the same workspace never leak into each other’s list() results', async () => {
    const workspaceId = await createWorkspace();
    const userA = await fakeActor();
    const userB = await fakeActor();
    const agentX = await registerActiveAgent(workspaceId);
    const agentY = await registerActiveAgent(workspaceId);

    const sentAX = await service.send(
      workspaceId,
      userA,
      'admin',
      agentX,
      scriptedDmMessage([oneValidReconfigureAction(agentX)]),
    );
    const sentAY = await service.send(
      workspaceId,
      userA,
      'admin',
      agentY,
      scriptedDmMessage([oneValidReconfigureAction(agentY)]),
    );
    const sentBY = await service.send(
      workspaceId,
      userB,
      'admin',
      agentY,
      scriptedDmMessage([oneValidReconfigureAction(agentY)]),
    );

    const threadAX = await service.list(workspaceId, userA.id, userA.id, agentX, 'admin');
    const threadAY = await service.list(workspaceId, userA.id, userA.id, agentY, 'admin');
    const threadBY = await service.list(workspaceId, userB.id, userB.id, agentY, 'admin');

    expect(threadAX.map((m) => m.id).sort()).toEqual(
      [sentAX.userMessage.id, sentAX.agentReply.id].sort(),
    );
    expect(threadAY.map((m) => m.id).sort()).toEqual(
      [sentAY.userMessage.id, sentAY.agentReply.id].sort(),
    );
    expect(threadBY.map((m) => m.id).sort()).toEqual(
      [sentBY.userMessage.id, sentBY.agentReply.id].sort(),
    );

    // No cross-contamination across the agent axis for the same user, nor
    // across the user axis for the same agent.
    expect(threadAX.some((m) => sentAY.userMessage.id === m.id)).toBe(false);
    expect(threadAY.some((m) => sentBY.userMessage.id === m.id)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // send() -- the double-failure sentinel (parseError: true) still records
  // a reply, never throws
  // ---------------------------------------------------------------------

  it('10. send() where extractDirectMessageReconfiguration returns parseError: true still resolves with a persisted agent reply (proposalId null) whose body is a non-empty string', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = await fakeActor();
    const agentIdentifier = await registerActiveAgent(workspaceId);
    // Deliberately invalid JSON on both the first attempt and the retry.
    const dmMessageText = `Garbled DM. ${RETURN_MARKER}{not valid json at all`;

    const { userMessage, agentReply } = await service.send(
      workspaceId,
      adminActor,
      'admin',
      agentIdentifier,
      dmMessageText,
    );

    expect(userMessage.body).toBe(dmMessageText);
    expect(agentReply.sender).toBe('agent');
    expect(agentReply.proposalId).toBeNull();
    expect(typeof agentReply.body).toBe('string');
    expect(agentReply.body.length).toBeGreaterThan(0);
  });
});
