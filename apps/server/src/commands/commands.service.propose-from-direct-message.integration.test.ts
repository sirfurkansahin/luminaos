import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import { ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MockInstance } from 'vitest';

/**
 * F3-T3 PR4 (RED step), ADR-0037 §4 — `CommandsService.proposeFromDirectMessage()`:
 * the DM-triggered sibling of `parse()`/`proposeFromMeeting()`, sharing the
 * existing `recordProposal` event-recording helper but sourcing its proposed
 * actions from `extractDirectMessageReconfiguration`
 * (`../ai/extract-direct-message-reconfiguration.ts`, this same PR's OTHER
 * new file) instead of `parseCommand`/`extractMeetingActions`, and authoring
 * its `ActionsProposed` event as the fixed `DM_RECONFIGURATION_ACTOR`
 * (`{type:'agent', id:'dm-reconfiguration-parser'}`) -- never
 * `COMMAND_PARSER_ACTOR`/`MEETING_ACTION_EXTRACTOR_ACTOR`/`TRIGGER_ENGINE_ACTOR`,
 * and NEVER the calling human's own `actor` argument, no matter what that
 * argument is.
 *
 * The DEFINING difference from every other `propose*` method (ADR-0037 §4):
 * `proposeFromDirectMessage` performs a SYNCHRONOUS, pre-AI-call admin-gate
 * check (`hasAtLeastRole(callerRole, 'admin')`) as its literal first line --
 * a non-admin caller must be rejected with `ForbiddenError` BEFORE
 * `aiUsageService`/`aiProvider` are touched at all (no quota spent, no event
 * recorded). This is the property every AC1 test below pins via a
 * `vi.spyOn(provider, 'complete')` spy.
 *
 * Nothing under test here exists yet: `CommandsService.proposeFromDirectMessage`
 * does not exist on `./commands.service.ts`'s real class today. Every test
 * below is expected to fail (red) until `implementer` adds it, matching this
 * file's pinned contract precisely.
 *
 * HARNESS NOTE: mirrors `./commands.service.propose-from-meeting.integration.test.ts`'s
 * LIGHTWEIGHT harness exactly (Testcontainers Postgres only, no Redis, no
 * full Nest app boot, no HTTP) -- `CommandsService` is manually `new`'d with
 * only the 5 constructor params this file's own tests actually exercise
 * (`db`/`eventStore`/`projectionRunner`/`aiUsageService`/`aiProvider`); this
 * PR's OWN new trailing constructor param (`agentPermissionManifestsService`)
 * is irrelevant to `proposeFromDirectMessage` itself (it is only ever read
 * inside `executeReconfigureAgentPermissions`, exercised by this PR's OTHER,
 * sibling integration test file instead) and is simply omitted here, mirroring
 * how `./commands.service.propose-from-meeting.integration.test.ts` itself
 * already omits the (at-the-time-already-real) `objectsService`/
 * `relationsService`/`workspaceMembershipService` trailing params for the
 * exact same reason.
 *
 * The scripted-AI-response trick below is the SAME `RETURN:<json>` marker
 * convention as every other file in this directory, applied to
 * `extractDirectMessageReconfiguration`'s OWN prompt template instead
 * (embedding the marker inside `dmMessageText`, which that function's own
 * prompt is expected to embed verbatim somewhere in its rendered text,
 * mirroring `renderMeetingActionsPrompt`'s `Transcript: ${transcriptText}`
 * precedent).
 */

/** ADR-0037 §4's fixed actor for every DM-triggered `ActionsProposed` event --
 * deliberately distinct from every other fixed proposal-source actor in this
 * codebase (an audit query can tell all four proposal sources apart purely
 * from `actor.id`). */
const DM_RECONFIGURATION_ACTOR = { type: 'agent', id: 'dm-reconfiguration-parser' } as const;
const PROPOSAL_STREAM_TYPE = 'action-proposal';
const RETURN_MARKER = 'RETURN:';

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

/** The public contract `CommandsService` must satisfy once `implementer` adds
 * `proposeFromDirectMessage` -- declared locally (not statically imported),
 * same reasoning as every other file in this directory. */
interface CommandsServiceContract {
  proposeFromDirectMessage(
    workspaceId: string,
    actor: Actor,
    callerRole: 'owner' | 'admin' | 'member' | 'guest',
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

describe('CommandsService.proposeFromDirectMessage() (real Postgres via Testcontainers)', () => {
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
    process.env.REDIS_URL = 'redis://propose-from-dm-test-placeholder:6379';
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

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

  /** Same `RETURN:<json>` marker convention as every other test file in this
   * directory, applied to `extractDirectMessageReconfiguration`'s own prompt
   * template. */
  function scriptedDmMessage(actions: Record<string, unknown>[]): string {
    return `Please grant triage-bot access to answer questions. ${RETURN_MARKER}${JSON.stringify(actions)}`;
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

  // ---------------------------------------------------------------------
  // AC1 -- non-admin callers are rejected BEFORE any AI provider call
  // ---------------------------------------------------------------------

  describe('AC1: a non-admin caller (member) requesting a reconfiguration via DM', () => {
    it('rejects with ForbiddenError, the AI provider is NEVER called, and no command_proposals row is created', async () => {
      const workspaceId = await createWorkspace('propose-from-dm-ac1-member');
      const actor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'triage-bot';
      const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

      const callsBefore = completeSpy.mock.calls.length;

      await expect(
        service.proposeFromDirectMessage(
          workspaceId,
          actor,
          'member',
          agentIdentifier,
          dmMessageText,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(completeSpy.mock.calls.length).toBe(callsBefore);
      expect(await countProposalRows(workspaceId)).toBe(0);
    });
  });

  describe('AC1b: a non-admin caller (guest) requesting a reconfiguration via DM', () => {
    it('rejects with ForbiddenError, the AI provider is NEVER called, and no command_proposals row is created', async () => {
      const workspaceId = await createWorkspace('propose-from-dm-ac1-guest');
      const actor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'triage-bot';
      const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

      const callsBefore = completeSpy.mock.calls.length;

      await expect(
        service.proposeFromDirectMessage(
          workspaceId,
          actor,
          'guest',
          agentIdentifier,
          dmMessageText,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(completeSpy.mock.calls.length).toBe(callsBefore);
      expect(await countProposalRows(workspaceId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- an admin caller: happy path, fixed-actor attribution, verbatim
  // command storage (NO redaction -- unlike proposeFromMeeting's transcript
  // discipline, ADR-0037 §4's own "kısa insan-yazılı metin" rationale)
  // ---------------------------------------------------------------------

  describe('AC2: an admin caller requesting a valid reconfiguration via DM', () => {
    it("persists an ActionsProposed event authored by DM_RECONFIGURATION_ACTOR (never the calling admin's own actor), command equals dmMessageText verbatim, sourceObjectId is null, and exactly one reconfigureAgentPermissions action is returned", async () => {
      const workspaceId = await createWorkspace('propose-from-dm-ac2-admin');
      const callingAdminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'triage-bot';
      const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

      const result = await service.proposeFromDirectMessage(
        workspaceId,
        callingAdminActor,
        'admin',
        agentIdentifier,
        dmMessageText,
      );

      expect(result.parseError).toBe(false);
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]?.type).toBe('reconfigureAgentPermissions');
      expect(typeof result.actions[0]?.actionId).toBe('string');

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.workspace_id).toBe(workspaceId);
      expect(row?.source_object_id).toBeNull();
      expect(row?.command).toBe(dmMessageText);

      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(1);
      expect(row?.decisions).toBeNull();
      expect(row?.decided_at).toBeNull();

      const streamEvents = await eventStore.readStream(row?.stream_id ?? '');
      const proposedEvent = streamEvents.find((event) => event.type === 'ActionsProposed');
      expect(proposedEvent).toBeDefined();
      expect(proposedEvent?.streamType).toBe(PROPOSAL_STREAM_TYPE);
      expect(proposedEvent?.actor).toEqual(DM_RECONFIGURATION_ACTOR);
      expect(proposedEvent?.actor).not.toEqual(callingAdminActor);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- the double-failure sentinel: extractDirectMessageReconfiguration
  // returning parseError: true still durably records an empty-actions
  // ActionsProposed event (same "always record the attempt" discipline as
  // parse()/proposeFromMeeting's own equivalent test)
  // ---------------------------------------------------------------------

  describe('AC3: extractDirectMessageReconfiguration returning parseError: true still appends an empty-actions ActionsProposed event', () => {
    it('proposeFromDirectMessage resolves (never throws) with { actions: [], parseError: true, message } AND a command_proposals row with an empty actions array', async () => {
      const workspaceId = await createWorkspace('propose-from-dm-ac3-double-failure');
      const callingAdminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'triage-bot';
      // Deliberately invalid JSON on both the first attempt and the retry
      // (extractDirectMessageReconfiguration retries once against the SAME
      // rendered prompt).
      const dmMessageText = `Garbled DM. ${RETURN_MARKER}{not valid json at all`;

      const result = await service.proposeFromDirectMessage(
        workspaceId,
        callingAdminActor,
        'admin',
        agentIdentifier,
        dmMessageText,
      );

      expect(result.parseError).toBe(true);
      expect(result.actions).toEqual([]);
      expect(typeof result.message).toBe('string');
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.source_object_id).toBeNull();
      expect(row?.command).toBe(dmMessageText);
      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(0);
      expect(row?.decisions).toBeNull();
      expect(await countProposalRows(workspaceId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- cross-workspace isolation of DM-triggered proposals
  // ---------------------------------------------------------------------

  describe('AC4: a DM-triggered proposal created in workspace A is not visible when querying workspace B', () => {
    it('countProposalRows for workspace B stays 0 after a proposeFromDirectMessage() call in workspace A', async () => {
      const workspaceA = await createWorkspace('propose-from-dm-ac4-a');
      const workspaceB = await createWorkspace('propose-from-dm-ac4-b');
      const callingAdminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'triage-bot';
      const dmMessageText = scriptedDmMessage([oneValidReconfigureAction(agentIdentifier)]);

      await service.proposeFromDirectMessage(
        workspaceA,
        callingAdminActor,
        'admin',
        agentIdentifier,
        dmMessageText,
      );

      expect(await countProposalRows(workspaceA)).toBe(1);
      expect(await countProposalRows(workspaceB)).toBe(0);
    });
  });
});
