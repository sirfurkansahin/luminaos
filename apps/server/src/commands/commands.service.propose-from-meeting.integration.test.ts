import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import { QuotaExceededError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MockInstance } from 'vitest';

/**
 * F2-T14 PR4 (RED step), ADR-0031 §h — `CommandsService.proposeFromMeeting()`:
 * the meeting-triggered sibling of `parse()`, sharing its `recordProposal`
 * event-recording helper (ADR-0031 §h) but sourcing its proposed actions from
 * `extractMeetingActions` (`../ai/extract-meeting-actions.ts`, already real as
 * of F2-T14 PR3) instead of `parseCommand`, and authoring its `ActionsProposed`
 * event as the fixed `MEETING_ACTION_EXTRACTOR_ACTOR` (`{type:'agent',
 * id:'meeting-action-extractor'}`), never the fixed `COMMAND_PARSER_ACTOR`
 * `parse()` uses and never any calling-context actor (there IS no calling-user
 * actor for this method at all — see its 3-argument signature below).
 *
 * Nothing under test here exists yet: `CommandsService.proposeFromMeeting`
 * does not exist on `./commands.service.ts`'s real class today (PR3 only
 * widened `ProposedAction`/added `extractMeetingActions`; PR4 is this method's
 * own PR). Every test below is expected to fail (red) until `implementer`
 * adds it, matching this file's pinned contract precisely.
 *
 * Mirrors `./commands.service.integration.test.ts`'s LIGHTWEIGHT harness
 * exactly (no full Nest app boot, no Redis, no HTTP): `CommandsService` is
 * manually `new`'d with its 5 ORIGINAL constructor deps only (`db`/
 * `eventStore`/`projectionRunner`/`aiUsageService`/`aiProvider`) — this PR's
 * additions (`recordProposal`/`proposeFromMeeting`/
 * `MEETING_ACTION_EXTRACTOR_ACTOR`/`executeCreateTaskFromMeeting`) need no NEW
 * constructor dependency, so this file deliberately stays a sibling of PR4's
 * OWN original file rather than PR5's full-`AppModule` one (see
 * `./commands.service.execute-create-task-from-meeting.integration.test.ts`
 * for the `executeCreateTaskFromMeeting`/`decide()` coverage, which DOES need
 * the full harness for real `ObjectsService`/field definitions).
 *
 * The scripted-AI-response trick below is the SAME `RETURN:<json>` marker
 * convention as `./commands.service.integration.test.ts`'s own
 * `scriptedActionsCommand`, applied to `extractMeetingActions`'s OWN prompt
 * template instead (`renderMeetingActionsPrompt`'s last line is always
 * `Transcript: ${transcriptText}` — embedding the marker inside
 * `transcriptText` puts it, and everything scripted after it, at the very end
 * of the rendered prompt, exactly mirroring how `parseCommand`'s own
 * `Command: ${command}` line works).
 */

const COMMAND_PARSER_ACTOR = { type: 'agent', id: 'command-parser' } as const;
/** ADR-0031 §h's fixed actor for every meeting-triggered `ActionsProposed`
 * event — deliberately distinct from `COMMAND_PARSER_ACTOR` (an audit query
 * can tell the two proposal sources apart purely from `actor.id`). */
const MEETING_ACTION_EXTRACTOR_ACTOR = { type: 'agent', id: 'meeting-action-extractor' } as const;
const PROPOSAL_STREAM_TYPE = 'action-proposal';
const RETURN_MARKER = 'RETURN:';
/** A distinctive substring planted inside the RAW transcript text (before the
 * `RETURN:` marker) — every test below asserts this substring never appears
 * anywhere in the persisted `command_proposals.command` column, proving the
 * raw transcript is never copied there verbatim (ADR-0031 §f). */
const RAW_TRANSCRIPT_MARKER = 'RAW-TRANSCRIPT-CONTENT-8f3d21-do-not-persist-verbatim';

interface ProposedActionContract {
  actionId: string;
  type: 'createTask' | 'generateSubtasks' | 'assignPeople' | 'createTaskFromMeeting';
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
 * `proposeFromMeeting` — declared locally (not statically imported), same
 * reasoning as `./commands.service.integration.test.ts`'s own
 * `CommandsServiceContract`. */
interface CommandsServiceContract {
  proposeFromMeeting(
    workspaceId: string,
    meetingObjectId: string,
    transcriptText: string,
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

const TOKEN_QUOTA_PER_WORKSPACE = 10;
const COST_BUDGET_USD_PER_WORKSPACE = 10;

describe('CommandsService.proposeFromMeeting() (real Postgres via Testcontainers)', () => {
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
    process.env.REDIS_URL = 'redis://propose-from-meeting-test-placeholder:6379';
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

    function respond(request: AICompletionRequest): AICompletionResult {
      const markerIndex = request.prompt.indexOf(RETURN_MARKER);

      if (markerIndex === -1) {
        throw new Error('Test bug: rendered prompt has no RETURN: marker');
      }

      return {
        text: request.prompt.slice(markerIndex + RETURN_MARKER.length),
        usage: { inputTokens: 100, outputTokens: 20 },
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

  async function seedPriorUsageCost(workspaceId: string, costUsd: string): Promise<void> {
    await db.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, NULL, NULL, $3, $4, $5, $6, now())`,
      [crypto.randomUUID(), workspaceId, 0, 0, null, costUsd],
    );
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

  /** Same `RETURN:<json>` marker convention as
   * `./commands.service.integration.test.ts`'s `scriptedActionsCommand`, but
   * plants `RAW_TRANSCRIPT_MARKER` in the text BEFORE the marker so every
   * test can assert that substring never reaches `command_proposals.command`
   * (ADR-0031 §f). */
  function scriptedTranscript(actions: Record<string, unknown>[]): string {
    return `Meeting notes mentioning ${RAW_TRANSCRIPT_MARKER}. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  const oneValidMeetingAction = {
    type: 'createTaskFromMeeting',
    intent: 'Create a follow-up task from the meeting',
    rationale: 'The transcript named a concrete action item',
    resources: [],
    rollbackNote: 'Delete the created task',
    params: { title: 'Follow up on the meeting' },
  };

  // ---------------------------------------------------------------------
  // AC1 -- happy path
  // ---------------------------------------------------------------------

  describe('AC1: a transcript that extracts into a valid createTaskFromMeeting action', () => {
    it('persists an ActionsProposed event authored by MEETING_ACTION_EXTRACTOR_ACTOR, sourceObjectId=meetingObjectId, and a synthetic command that never contains the raw transcript', async () => {
      const workspaceId = await createWorkspace('propose-from-meeting-ac1');
      const meetingObjectId = newObjectId();
      const transcriptText = scriptedTranscript([oneValidMeetingAction]);

      const result = await service.proposeFromMeeting(workspaceId, meetingObjectId, transcriptText);

      expect(result.parseError).toBe(false);
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]?.type).toBe('createTaskFromMeeting');
      expect(typeof result.actions[0]?.actionId).toBe('string');

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.workspace_id).toBe(workspaceId);
      expect(row?.source_object_id).toBe(meetingObjectId);

      // The synthetic command string (ADR-0031 §f) -- exact shape, never the
      // raw transcript.
      expect(row?.command).toBe(`[meeting-action-extraction] meetingObjectId=${meetingObjectId}`);
      expect(row?.command).not.toContain(RAW_TRANSCRIPT_MARKER);
      expect(row?.command).not.toContain(transcriptText);
      expect(row?.command).not.toContain(RETURN_MARKER);

      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(1);
      expect(row?.decisions).toBeNull();
      expect(row?.decided_at).toBeNull();

      const streamEvents = await eventStore.readStream(row?.stream_id ?? '');
      const proposedEvent = streamEvents.find((event) => event.type === 'ActionsProposed');
      expect(proposedEvent).toBeDefined();
      expect(proposedEvent?.streamType).toBe(PROPOSAL_STREAM_TYPE);
      expect(proposedEvent?.actor).toEqual(MEETING_ACTION_EXTRACTOR_ACTOR);
      expect(proposedEvent?.actor).not.toEqual(COMMAND_PARSER_ACTOR);
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- token quota exceeded, checked BEFORE the provider call, propagates
  // as a real rejection (not swallowed by this method itself -- PR5's
  // webhook caller is responsible for catching it, out of scope here)
  // ---------------------------------------------------------------------

  describe('AC2: token quota exceeded during proposeFromMeeting rejects before any provider call', () => {
    it('rejects with QuotaExceededError, the provider is never invoked, and no command_proposals row is created', async () => {
      const workspaceId = await createWorkspace('propose-from-meeting-ac2-token');
      await seedPriorUsageTokens(workspaceId, TOKEN_QUOTA_PER_WORKSPACE);
      const meetingObjectId = newObjectId();

      const callsBefore = completeSpy.mock.calls.length;
      const transcriptText = scriptedTranscript([oneValidMeetingAction]);

      await expect(
        service.proposeFromMeeting(workspaceId, meetingObjectId, transcriptText),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      expect(completeSpy.mock.calls.length).toBe(callsBefore);
      expect(await countProposalRows(workspaceId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- cost budget exceeded, checked BEFORE the provider call
  // ---------------------------------------------------------------------

  describe('AC3: cost budget exceeded during proposeFromMeeting rejects before any provider call', () => {
    it('rejects with QuotaExceededError, the provider is never invoked, and no command_proposals row is created', async () => {
      const workspaceId = await createWorkspace('propose-from-meeting-ac3-cost');
      await seedPriorUsageCost(workspaceId, '20.000000');
      const meetingObjectId = newObjectId();

      const callsBefore = completeSpy.mock.calls.length;
      const transcriptText = scriptedTranscript([oneValidMeetingAction]);

      await expect(
        service.proposeFromMeeting(workspaceId, meetingObjectId, transcriptText),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      expect(completeSpy.mock.calls.length).toBe(callsBefore);
      expect(await countProposalRows(workspaceId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- the double-failure sentinel: extractMeetingActions returning
  // parseError: true still durably records an empty-actions ActionsProposed
  // event (same "always record the attempt" discipline as parse()'s own AC5)
  // ---------------------------------------------------------------------

  describe('AC4: extractMeetingActions returning parseError: true still appends an empty-actions ActionsProposed event', () => {
    it('proposeFromMeeting resolves (never throws) with { actions: [], parseError: true, message } AND a command_proposals row with an empty actions array', async () => {
      const workspaceId = await createWorkspace('propose-from-meeting-ac4');
      const meetingObjectId = newObjectId();
      // No RETURN: marker at all would hit `respond()`'s tripwire, so we
      // script a marker whose payload is deliberately invalid JSON on BOTH
      // the first attempt and the retry (extractMeetingActions retries once
      // against the SAME rendered prompt).
      const transcriptText = `Garbled meeting notes. ${RETURN_MARKER}{not valid json at all`;

      const result = await service.proposeFromMeeting(workspaceId, meetingObjectId, transcriptText);

      expect(result.parseError).toBe(true);
      expect(result.actions).toEqual([]);
      expect(typeof result.message).toBe('string');
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.source_object_id).toBe(meetingObjectId);
      expect(row?.command).toBe(`[meeting-action-extraction] meetingObjectId=${meetingObjectId}`);
      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(0);
      expect(row?.decisions).toBeNull();
      expect(await countProposalRows(workspaceId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- cross-workspace isolation of meeting-triggered proposals
  // ---------------------------------------------------------------------

  describe('AC5: a meeting-triggered proposal created in workspace A is not visible when querying workspace B', () => {
    it('countProposalRows for workspace B stays 0 after a proposeFromMeeting() call in workspace A', async () => {
      const workspaceA = await createWorkspace('propose-from-meeting-ac5-a');
      const workspaceB = await createWorkspace('propose-from-meeting-ac5-b');
      const meetingObjectId = newObjectId();
      const transcriptText = scriptedTranscript([oneValidMeetingAction]);

      await service.proposeFromMeeting(workspaceA, meetingObjectId, transcriptText);

      expect(await countProposalRows(workspaceA)).toBe(1);
      expect(await countProposalRows(workspaceB)).toBe(0);
    });
  });
});
