import crypto, { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MockInstance } from 'vitest';

/**
 * F2-T15 PR3 (RED step), ADR-0032 Karar (f) — `CommandsService.proposeFromTrigger()`:
 * the THIRD fixed-actor caller of the already-generic `recordProposal` helper
 * (ADR-0031 §h), sitting alongside `parse()` (`COMMAND_PARSER_ACTOR`) and
 * `proposeFromMeeting()` (`MEETING_ACTION_EXTRACTOR_ACTOR`). Deliberately
 * SIMPLER than both existing callers: `actions` are handed in DIRECTLY by the
 * (future PR5) caller, already fully formed from a trigger's own stored
 * `actionTemplate` (`packages/automation/src/trigger.ts`'s `ActionTemplate`,
 * `{title: string}`) — there is no AI call at all, so unlike `parse()`/
 * `proposeFromMeeting()` this method must NEVER touch
 * `AIUsageService.withWorkspaceAILock`/quota/budget checks, and `parseError`
 * is always `false` (there is no parse step that can fail).
 *
 * Nothing under test here exists yet: `CommandsService.proposeFromTrigger`
 * does not exist on `./commands.service.ts`'s real class today (nor does the
 * `TRIGGER_ENGINE_ACTOR` constant, nor the `'createTaskFromTrigger'`
 * `ProposedAction`/`proposedActionSchema` union member this file's fixture
 * actions rely on structurally). Every test below is expected to fail (red)
 * until `implementer` adds it, matching this file's pinned contract exactly.
 *
 * Mirrors `./commands.service.propose-from-meeting.integration.test.ts`'s
 * LIGHTWEIGHT harness exactly (no full Nest app boot, no Redis, no HTTP):
 * `CommandsService` is manually `new`'d with its 5 ORIGINAL constructor deps
 * only (`db`/`eventStore`/`projectionRunner`/`aiUsageService`/`aiProvider`) —
 * `proposeFromTrigger` needs no NEW constructor dependency and, unlike
 * `proposeFromMeeting`, doesn't even touch `aiUsageService`/`aiProvider` at
 * runtime; they're still threaded through the constructor purely because the
 * real class's constructor shape is fixed by its OTHER methods.
 *
 * `actionId` design note (test-writer judgment call, not 100% pinned by the
 * ADR excerpt): unlike `parse()`/`proposeFromMeeting()` (which source their
 * actions from `parseCommand`/`extractMeetingActions`, both of which MINT a
 * fresh `actionId` via `crypto.randomUUID()` internally), `proposeFromTrigger`
 * receives already-fully-formed `ProposedAction[]` — including `actionId` —
 * from its caller. This file therefore mints `actionId` itself (via
 * `randomUUID()`) in its own fixture actions, mirroring how a real PR5
 * trigger-engine caller would be expected to mint one before calling
 * `proposeFromTrigger`, since `recordProposal` itself has no id-minting step
 * of its own (verified by reading `recordProposal`'s body: it persists
 * `actions` verbatim).
 */

const COMMAND_PARSER_ACTOR = { type: 'agent', id: 'command-parser' } as const;
const MEETING_ACTION_EXTRACTOR_ACTOR = { type: 'agent', id: 'meeting-action-extractor' } as const;
/** ADR-0032 Karar (f)'s fixed actor for every trigger-produced
 * `ActionsProposed` event — deliberately distinct from BOTH existing fixed
 * actors, so an audit query can tell all three proposal sources apart purely
 * from `actor.id`. */
const TRIGGER_ENGINE_ACTOR = { type: 'agent', id: 'trigger-engine' } as const;
const PROPOSAL_STREAM_TYPE = 'action-proposal';

const TOKEN_QUOTA_PER_WORKSPACE = 10;
const COST_BUDGET_USD_PER_WORKSPACE = 10;

interface ProposedActionContract {
  actionId: string;
  type:
    | 'createTask'
    | 'generateSubtasks'
    | 'assignPeople'
    | 'createTaskFromMeeting'
    | 'createTaskFromTrigger';
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

/** The public contract `CommandsService` must satisfy once `implementer` adds
 * `proposeFromTrigger` — declared locally (not statically imported), same
 * reasoning as every other file in this directory. */
interface CommandsServiceContract {
  proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string,
    actions: ProposedActionContract[],
  ): Promise<CommandsServiceParseResult>;
}

type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageServiceContract,
  aiProvider: AIProvider,
) => CommandsServiceContract;

interface RawCommandProposalRow {
  id: string;
  stream_id: string;
  workspace_id: string;
  command: string;
  source_object_id: string | null;
  actions: unknown;
  decisions: unknown;
  created_at: Date;
  decided_at: Date | null;
}

describe('CommandsService.proposeFromTrigger() (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let aiUsageService: AIUsageServiceContract;
  let provider: MockProvider;
  let completeSpy: MockInstance<AIProvider['complete']>;
  let service: CommandsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://propose-from-trigger-test-placeholder:6379';
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = String(TOKEN_QUOTA_PER_WORKSPACE);
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = String(COST_BUDGET_USD_PER_WORKSPACE);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    const aiUsageModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageModule as { AIUsageService: AIUsageServiceConstructor })
      .AIUsageService;
    aiUsageService = new AIUsageServiceCtor(db, eventStore, projectionRunner);

    // This provider must NEVER be invoked by `proposeFromTrigger` -- any call
    // reaching it is itself a test failure (asserted via `completeSpy` call
    // counts below), so its response body is irrelevant/a tripwire value.
    function respond(): AICompletionResult {
      throw new Error(
        'Test bug (or implementer regression): proposeFromTrigger must never call provider.complete',
      );
    }

    provider = new MockProvider(respond);
    completeSpy = vi.spyOn(provider, 'complete');

    const commandsModule: unknown = await import('./commands.service.js');
    const CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;
    service = new CommandsServiceCtor(db, eventStore, projectionRunner, aiUsageService, provider);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: crypto.randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  async function seedPriorUsageTokens(workspaceId: string, tokens: number): Promise<void> {
    await db.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, NULL, NULL, $3, $4, $5, $6, now())`,
      [crypto.randomUUID(), workspaceId, tokens, 0, null, '0.000000'],
    );
  }

  async function getProposalRow(proposalId: string): Promise<RawCommandProposalRow | undefined> {
    const result = await db.$client.query<RawCommandProposalRow>(
      'select id, stream_id, workspace_id, command, source_object_id, actions, decisions, created_at, decided_at from command_proposals where id = $1',
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

  /** A single schema-valid `createTaskFromTrigger` action -- WITH an
   * `actionId` already minted (unlike `parseCommand`'s/`extractMeetingActions`'s
   * fixtures), since `proposeFromTrigger` receives already-fully-formed
   * `ProposedAction[]` from its (future) caller and mints no id of its own. */
  function createTaskFromTriggerAction(
    overrides: Partial<ProposedActionContract> = {},
  ): ProposedActionContract {
    return {
      actionId: randomUUID(),
      type: 'createTaskFromTrigger',
      intent: 'Create a task from a matched trigger',
      rationale: 'The trigger condition matched and its action template requested a task',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: { title: 'Follow up from trigger match' },
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------
  // AC1 -- happy path: exactly one ActionsProposed event, payload shape
  // ---------------------------------------------------------------------

  describe('AC1: a valid single-action array', () => {
    it('appends exactly one ActionsProposed event whose payload.actions matches what was passed in, payload.sourceObjectId === sourceObjectId, and payload.command is the synthetic "[trigger] triggerId=..." string (never raw trigger internals beyond the id)', async () => {
      const workspaceId = await createWorkspace('propose-from-trigger-ac1');
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const action = createTaskFromTriggerAction();

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        action,
      ]);

      expect(result.parseError).toBe(false);
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);
      expect(result.actions).toEqual([action]);

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.workspace_id).toBe(workspaceId);
      expect(row?.source_object_id).toBe(sourceObjectId);
      expect(row?.command).toBe(`[trigger] triggerId=${triggerId}`);
      expect(Array.isArray(row?.actions)).toBe(true);
      expect(row?.actions).toEqual([action]);
      expect(row?.decisions).toBeNull();
      expect(row?.decided_at).toBeNull();

      const streamEvents = await eventStore.readStream(row?.stream_id ?? '');
      const proposedEvents = streamEvents.filter((event) => event.type === 'ActionsProposed');
      expect(proposedEvents).toHaveLength(1);
      const proposedEvent = proposedEvents[0];
      expect(proposedEvent?.streamType).toBe(PROPOSAL_STREAM_TYPE);
      const payload = proposedEvent?.payload as {
        proposalId: string;
        sourceObjectId?: string;
        command: string;
        actions: unknown;
      };
      expect(payload.actions).toEqual([action]);
      expect(payload.sourceObjectId).toBe(sourceObjectId);
      expect(payload.command).toBe(`[trigger] triggerId=${triggerId}`);
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- actor attribution: distinct from the other two fixed actors
  // ---------------------------------------------------------------------

  describe('AC2: the ActionsProposed event is authored by TRIGGER_ENGINE_ACTOR', () => {
    it('actor is {type:"agent", id:"trigger-engine"}, distinguishable from COMMAND_PARSER_ACTOR and MEETING_ACTION_EXTRACTOR_ACTOR', async () => {
      const workspaceId = await createWorkspace('propose-from-trigger-ac2');
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        createTaskFromTriggerAction(),
      ]);

      const row = await getProposalRow(result.proposalId);
      const streamEvents = await eventStore.readStream(row?.stream_id ?? '');
      const proposedEvent = streamEvents.find((event) => event.type === 'ActionsProposed');

      expect(proposedEvent?.actor).toEqual(TRIGGER_ENGINE_ACTOR);
      expect(proposedEvent?.actor).not.toEqual(COMMAND_PARSER_ACTOR);
      expect(proposedEvent?.actor).not.toEqual(MEETING_ACTION_EXTRACTOR_ACTOR);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- CommandsServiceParseResult shape: parseError always false
  // ---------------------------------------------------------------------

  describe('AC3: the returned CommandsServiceParseResult', () => {
    it('has parseError: false always, and proposalId/actions matching what was recorded', async () => {
      const workspaceId = await createWorkspace('propose-from-trigger-ac3');
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const action = createTaskFromTriggerAction({ params: { title: 'AC3 task' } });

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        action,
      ]);

      expect(result.parseError).toBe(false);
      expect(result.message).toBeUndefined();
      expect(result.actions).toEqual([action]);

      const row = await getProposalRow(result.proposalId);
      expect(row?.actions).toEqual([action]);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- no AI provider invoked, even when the workspace is already over
  // its token quota (proposeFromTrigger has no AI call to gate at all)
  // ---------------------------------------------------------------------

  describe('AC4: no AI provider call and no AI-usage-quota check, even for a workspace already at/over its token quota', () => {
    it('succeeds (does not throw QuotaExceededError) and never invokes provider.complete', async () => {
      const workspaceId = await createWorkspace('propose-from-trigger-ac4');
      await seedPriorUsageTokens(workspaceId, TOKEN_QUOTA_PER_WORKSPACE + 1);
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();

      const callsBefore = completeSpy.mock.calls.length;

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        createTaskFromTriggerAction(),
      ]);

      expect(result.parseError).toBe(false);
      expect(completeSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- cross-workspace isolation
  // ---------------------------------------------------------------------

  describe('AC5: the created proposal is scoped to the calling workspace only', () => {
    it("the proposal's workspaceId matches the caller's workspaceId argument, and a different workspace's proposal count stays 0", async () => {
      const workspaceA = await createWorkspace('propose-from-trigger-ac5-a');
      const workspaceB = await createWorkspace('propose-from-trigger-ac5-b');
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();

      const result = await service.proposeFromTrigger(workspaceA, triggerId, sourceObjectId, [
        createTaskFromTriggerAction(),
      ]);

      const row = await getProposalRow(result.proposalId);
      expect(row?.workspace_id).toBe(workspaceA);
      expect(row?.workspace_id).not.toBe(workspaceB);

      expect(await countProposalRows(workspaceA)).toBe(1);
      expect(await countProposalRows(workspaceB)).toBe(0);
    });
  });
});
