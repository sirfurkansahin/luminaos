import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CLAUDE_SONNET_5, MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import { QuotaExceededError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MockInstance } from 'vitest';

/**
 * F1-T16 PR4 (RED step), ADR-0015 -- `CommandsService.parse()`: orchestrates
 * quota/lock discipline (`AIUsageService`, already real as of F1-T15 PR2),
 * `selectAIModel({ outputType: 'command' })` (already real as of F1-T16 PR2),
 * `parseCommand` (already real as of F1-T16 PR2), and persists the result as
 * a NEW `ActionsProposed` event on its own dedicated `action-proposal`
 * stream (ADR-0015 §b), backed by the `command_proposals` read model
 * (`./action-proposal.projection.integration.test.ts` pins that projection's
 * own contract separately).
 *
 * Nothing under test here exists yet:
 *   - `./commands.service.ts` (`CommandsService`) does not exist.
 *   - `./action-proposal.projection.ts` does not exist.
 *   - The `command_proposals` table does not exist.
 * Every test below is expected to fail (red) until `implementer` builds all
 * three, matching this file's + `./action-proposal.projection.integration.test.ts`'s
 * pinned contracts precisely.
 *
 * Mirrors `../ai/ai-usage.service.integration.test.ts`'s LIGHTWEIGHT harness
 * exactly (no full Nest app boot, no HTTP layer -- `CommandsController`
 * doesn't exist until PR6): `CommandsService` is manually `new`'d with its
 * real dependencies (`Database`, `EventStoreService`, `ProjectionRunner`,
 * `AIUsageService`, an `AIProvider`), bypassing Nest DI/decorators entirely
 * (constructing a class directly ignores `@Inject`/`@Injectable`, exactly as
 * that precedent file does for `AIUsageService`).
 *
 * `AIUsageService` reads `env.aiTokenQuotaPerWorkspace`/
 * `env.aiCostBudgetUsdPerWorkspace` (`../config/env.js`'s eagerly-evaluated
 * singleton), so -- mirroring `ai-usage.service.integration.test.ts`'s own
 * documented reasoning -- `process.env.*` is set in `beforeAll` BEFORE
 * `AIUsageService` (and `CommandsService`, which also has no reason to read
 * `env.js` itself but is dynamically imported regardless, since it doesn't
 * exist yet) is imported. This file deliberately has NO top-level static
 * import of `../ai/ai-usage.service.js` or `./commands.service.js`.
 *
 * ============================================================================
 * DESIGN DECISIONS THIS TEST FILE PINS (implementer must match precisely):
 *
 * --- 1. `CommandsService`'s constructor + `parse()` signature ------------
 *
 *   class CommandsService {
 *     constructor(
 *       db: Database,
 *       eventStore: EventStoreService,
 *       projectionRunner: ProjectionRunner,
 *       aiUsageService: AIUsageService,
 *       aiProvider: AIProvider,
 *     );
 *     async parse(
 *       workspaceId: string,
 *       actor: Actor,          // the CALLING USER's actor -- see design
 *                               // decision 3 below for why this is NOT the
 *                               // actor written onto the ActionsProposed event
 *       command: string,
 *       sourceObjectId?: string,
 *     ): Promise<{
 *       proposalId: string;
 *       actions: ProposedAction[];   // from `../ai/parse-command.js`
 *       parseError: boolean;
 *       message?: string;
 *     }>;
 *   }
 *
 * --- 2. Orchestration shape (mirrors `../qa/qa.service.ts` exactly) -------
 *
 *   `aiUsageService.withWorkspaceAILock(workspaceId, async () => { ... })`
 *   wraps `assertAITokenQuotaNotExceeded` + `assertAICostBudgetNotExceeded`
 *   (checked ONCE, before calling `parseCommand`/the provider), then
 *   `selectAIModel({ outputType: 'command' })` (-> `CLAUDE_SONNET_5`), then
 *   `parseCommand({ provider: aiProvider, command, sourceObjectId, model,
 *   recordUsage: (usage) => aiUsageService.recordAIUsage(workspaceId,
 *   undefined, undefined, usage, model) })`.
 *
 * --- 3. Actor attribution (ADR-0015 §d) -----------------------------------
 *
 *   `ActionsProposed`'s persisted `actor` is ALWAYS the fixed constant
 *   `{ type: 'agent', id: 'command-parser' }`, regardless of what `actor`
 *   `parse()`'s caller passes in (the calling user's own actor plays no role
 *   in this event's attribution -- see AC6 below, which passes a `'user'`
 *   actor and asserts the RAW persisted event's actor is the fixed agent
 *   constant instead).
 *
 * --- 4. The double-failure sentinel (design decision, ADR-0015's audit-trail
 *        emphasis) -- `parseCommand` returning `{ actions: [], parseError:
 *        true, message }` STILL results in an `ActionsProposed` event being
 *        appended, with an EMPTY `actions` array -----------------------------
 *
 *   Chosen over silently discarding the attempt: ADR-0015's whole premise is
 *   that an agent's action-proposal attempt is auditable event-log history,
 *   not a transient in-memory result. Recording "the agent tried and failed
 *   to parse this command" is itself useful audit information (a failed
 *   attempt is a real fact about what happened), and it keeps a single,
 *   uniform code path: `CommandsService.parse()` ALWAYS produces exactly one
 *   `ActionsProposed` event + `command_proposals` row per call, regardless of
 *   `parseCommand`'s outcome -- no special-cased "sometimes there's a
 *   proposal, sometimes there isn't" branch for callers (including the future
 *   `decide` endpoint, PR5) to reason about. `parse()`'s OWN return value
 *   still surfaces `parseError`/`message` verbatim so the controller (PR6)
 *   can render an appropriate "could not understand this command" response
 *   without needing to inspect the (empty) `actions` array to infer failure.
 *   See AC5 below, which pins this exact behavior.
 * ============================================================================
 */

const PROPOSAL_STREAM_TYPE = 'action-proposal';
const COMMAND_PARSER_ACTOR = { type: 'agent', id: 'command-parser' } as const;
const RETURN_MARKER = 'RETURN:';

interface ProposedActionContract {
  actionId: string;
  type: 'createTask' | 'generateSubtasks' | 'assignPeople';
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

/**
 * The public contract `AIUsageService` already satisfies (real module, F1-T15
 * PR2) -- declared locally so `CommandsServiceContract`'s constructor type
 * below doesn't need a top-level static import of `../ai/ai-usage.service.js`
 * (see this file's header for why that import must stay dynamic/deferred).
 */
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

/**
 * The public contract `CommandsService` must satisfy, declared locally (see
 * this file's header for why) rather than imported statically -- contains the
 * resulting `import-x/no-unresolved` finding to the one dynamic-import line
 * in `beforeAll`, instead of an untyped `any` cascading into
 * `@typescript-eslint/no-unsafe-*` findings at every call site below.
 */
interface CommandsServiceContract {
  parse(
    workspaceId: string,
    actor: Actor,
    command: string,
    sourceObjectId?: string,
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

interface RawAIUsageRow {
  field_definition_id: string | null;
  object_id: string | null;
  model: string | null;
  cost_usd: string | null;
}

const TOKEN_QUOTA_PER_WORKSPACE = 10;
const COST_BUDGET_USD_PER_WORKSPACE = 10;

describe('CommandsService.parse() (real Postgres via Testcontainers)', () => {
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
    process.env.REDIS_URL = 'redis://commands-service-test-placeholder:6379';
    // A tiny shared token quota (far below one call's fixed 120 scripted
    // tokens, see `respond` below) -- mirrors
    // `ai-usage.service.integration.test.ts`'s and
    // `object-ai-refresh.integration.test.ts`'s identical design: every
    // test's FIRST parse() call, in its own freshly-created workspace, starts
    // at 0 prior usage and is always allowed (0 < 10); only a SECOND call, or
    // a workspace seeded above the threshold, is ever rejected.
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = String(TOKEN_QUOTA_PER_WORKSPACE);
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = String(COST_BUDGET_USD_PER_WORKSPACE);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Deferred (dynamic) import, AFTER `process.env.*` above is set -- see
    // this file's header for why (`AIUsageService` reads `env.js`'s
    // eagerly-evaluated singleton at module-load time).
    const aiUsageModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageModule as { AIUsageService: AIUsageServiceConstructor })
      .AIUsageService;
    aiUsageService = new AIUsageServiceCtor(db, eventStore, projectionRunner);

    // Same `RETURN:<text>` marker convention as
    // `../ai/ai-provider.module.ts`'s `unconfiguredResponder` /
    // `../qa/qa.integration.test.ts` / `../objects/object-ai-refresh.integration.test.ts`:
    // everything after the LITERAL substring `RETURN:` to the end of the
    // rendered prompt is returned verbatim as `text`, with a FIXED usage of
    // `{ inputTokens: 100, outputTokens: 20 }` (120 tokens/call) so quota math
    // stays simple and deterministic across every test in this file.
    function respond(request: AICompletionRequest): AICompletionResult {
      const markerIndex = request.prompt.indexOf(RETURN_MARKER);

      if (markerIndex === -1) {
        // Every test below always embeds the marker inside its own scripted
        // command text; hitting this path means a test has a bug, not a
        // legitimate "no marker" scenario.
        throw new Error('Test bug: rendered prompt has no RETURN: marker');
      }

      return {
        text: request.prompt.slice(markerIndex + RETURN_MARKER.length),
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }

    provider = new MockProvider(respond);
    completeSpy = vi.spyOn(provider, 'complete');

    // Deliberately unresolvable until `implementer` creates
    // `./commands.service.ts` -- see this file's header. The eslint-disable
    // below only silences the STATIC-ANALYSIS finding for this one line (the
    // module genuinely does not exist yet, the whole point of this RED
    // commit); the dynamic `import()` still throws a real "Cannot find
    // module" error at test-run time, which is the correct RED failure
    // reason. Remove this comment once `implementer` adds the file.
     
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

  /** Mirrors `object-ai-refresh.integration.test.ts`'s `seedPriorUsageCost` convention. */
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

  async function getLatestUsageRow(workspaceId: string): Promise<RawAIUsageRow | undefined> {
    const result = await db.$client.query<RawAIUsageRow>(
      'select field_definition_id, object_id, model, cost_usd from ai_usage_records where workspace_id = $1 order by created_at desc limit 1',
      [workspaceId],
    );
    return result.rows[0];
  }

  function scriptedActionsCommand(actions: Record<string, unknown>[]): string {
    return `Please act on this. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  const oneValidAction = {
    type: 'createTask',
    intent: 'Create a follow-up task',
    rationale: 'The user asked for one',
    resources: ['obj-parent-1'],
    rollbackNote: 'Delete the created task',
    params: { title: 'Follow up' },
  };

  const callingUserActor: Actor = { type: 'user', id: 'calling-user-1' };

  // ---------------------------------------------------------------------
  // AC1 -- happy path
  // ---------------------------------------------------------------------

  describe('AC1: a command that parses into a valid actions array', () => {
    it('returns { proposalId, actions, parseError: false } and persists a matching command_proposals row', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac1');
      const command = scriptedActionsCommand([oneValidAction]);

      const result = await service.parse(workspaceId, callingUserActor, command);

      expect(result.parseError).toBe(false);
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]?.type).toBe('createTask');
      expect(result.actions[0]?.intent).toBe(oneValidAction.intent);
      expect(typeof result.actions[0]?.actionId).toBe('string');

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.workspace_id).toBe(workspaceId);
      expect(row?.command).toBe(command);
      expect(row?.source_object_id).toBeNull();
      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(1);
      expect(row?.decisions).toBeNull();
      expect(row?.decided_at).toBeNull();
    });

    it('an optional sourceObjectId is passed through to both the return value’s persisted row and (indirectly) parseCommand', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac1-source');
      const command = scriptedActionsCommand([oneValidAction]);

      const result = await service.parse(
        workspaceId,
        callingUserActor,
        command,
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      );

      const row = await getProposalRow(result.proposalId);
      expect(row?.source_object_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('multiple proposed actions round-trip exactly (intent/rationale/resources/rollbackNote/params preserved)', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac1-multi');
      const secondAction = {
        type: 'assignPeople',
        intent: 'Assign the reviewer',
        rationale: 'The command named a specific person',
        resources: ['obj-parent-1'],
        rollbackNote: 'Unassign the reviewer',
        params: { userIds: ['user-42'] },
      };
      const command = scriptedActionsCommand([oneValidAction, secondAction]);

      const result = await service.parse(workspaceId, callingUserActor, command);

      expect(result.actions).toHaveLength(2);
      const actionIds = result.actions.map((action) => action.actionId);
      expect(new Set(actionIds).size).toBe(2);

      const second = result.actions.find((action) => action.type === 'assignPeople');
      expect(second?.params).toEqual({ userIds: ['user-42'] });
      expect(second?.resources).toEqual(['obj-parent-1']);
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- token quota exceeded, checked BEFORE the provider call
  // ---------------------------------------------------------------------

  describe('AC2: token quota exceeded rejects before any provider call', () => {
    it('rejects with QuotaExceededError, the provider is never invoked, and no command_proposals row is created', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac2-token');
      await seedPriorUsageTokens(workspaceId, TOKEN_QUOTA_PER_WORKSPACE);

      const callsBefore = completeSpy.mock.calls.length;
      const command = scriptedActionsCommand([oneValidAction]);

      await expect(service.parse(workspaceId, callingUserActor, command)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );

      expect(completeSpy.mock.calls.length).toBe(callsBefore);
      expect(await countProposalRows(workspaceId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- cost budget exceeded, checked BEFORE the provider call
  // ---------------------------------------------------------------------

  describe('AC3: cost budget exceeded rejects before any provider call', () => {
    it('rejects with QuotaExceededError, the provider is never invoked, and no command_proposals row is created', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac3-cost');
      await seedPriorUsageCost(workspaceId, '20.000000');

      const callsBefore = completeSpy.mock.calls.length;
      const command = scriptedActionsCommand([oneValidAction]);

      await expect(service.parse(workspaceId, callingUserActor, command)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );

      expect(completeSpy.mock.calls.length).toBe(callsBefore);
      expect(await countProposalRows(workspaceId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- usage recorded correctly on success
  // ---------------------------------------------------------------------

  describe('AC4: a successful parse() records a NULL-context ai_usage_records row', () => {
    it('field_definition_id and object_id are both NULL, model === CLAUDE_SONNET_5 (selectAIModel({outputType:"command"})), cost_usd is non-null', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac4');
      const command = scriptedActionsCommand([oneValidAction]);

      const result = await service.parse(workspaceId, callingUserActor, command);
      expect(result.parseError).toBe(false);

      const row = await getLatestUsageRow(workspaceId);
      expect(row).toBeDefined();
      expect(row?.field_definition_id).toBeNull();
      expect(row?.object_id).toBeNull();
      expect(row?.model).toBe(CLAUDE_SONNET_5);
      expect(row?.cost_usd).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- the double-failure sentinel: parseError still durably records an
  // empty-actions ActionsProposed event (design decision 4, this file's
  // header)
  // ---------------------------------------------------------------------

  describe('AC5: parseCommand returning parseError: true still appends an empty-actions ActionsProposed event', () => {
    it('parse() resolves (never throws) with { actions: [], parseError: true, message } AND a command_proposals row with an empty actions array', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac5');
      // No RETURN: marker at all -- `respond()`'s "no marker" branch normally
      // throws (a tripwire for THIS file's own tests), so instead we script a
      // marker whose payload is deliberately invalid JSON, on BOTH the first
      // attempt and the retry (parseCommand retries once against the SAME
      // rendered prompt, so the identical invalid text is returned both
      // times).
      const command = `Do something odd. ${RETURN_MARKER}{not valid json at all`;

      const result = await service.parse(workspaceId, callingUserActor, command);

      expect(result.parseError).toBe(true);
      expect(result.actions).toEqual([]);
      expect(typeof result.message).toBe('string');
      expect(typeof result.proposalId).toBe('string');
      expect(result.proposalId.length).toBeGreaterThan(0);

      // parseCommand retries once on a parse failure -- both attempts count.
      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.command).toBe(command);
      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(0);
      expect(row?.decisions).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC6 -- actor attribution (ADR-0015 §d): ActionsProposed's actor is the
  // fixed 'command-parser' agent constant, NEVER the calling user
  // ---------------------------------------------------------------------

  describe('AC6: the raw ActionsProposed event is authored by {type: "agent", id: "command-parser"}, not the calling user', () => {
    it('reading the raw event back from its own dedicated stream shows the fixed agent actor', async () => {
      const workspaceId = await createWorkspace('commands-svc-ac6');
      const command = scriptedActionsCommand([oneValidAction]);

      const result = await service.parse(workspaceId, callingUserActor, command);

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();

      const streamEvents = await eventStore.readStream(row?.stream_id ?? '');
      const proposedEvent = streamEvents.find((event) => event.type === 'ActionsProposed');

      expect(proposedEvent).toBeDefined();
      expect(proposedEvent?.streamType).toBe(PROPOSAL_STREAM_TYPE);
      expect(proposedEvent?.actor).toEqual(COMMAND_PARSER_ACTOR);
      expect(proposedEvent?.actor).not.toEqual(callingUserActor);
      expect(proposedEvent?.version).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // AC7 -- cross-workspace isolation of proposals
  // ---------------------------------------------------------------------

  describe('AC7: a proposal created in workspace A is not visible when querying workspace B', () => {
    it('countProposalRows for workspace B stays 0 after a parse() call in workspace A', async () => {
      const workspaceA = await createWorkspace('commands-svc-ac7-a');
      const workspaceB = await createWorkspace('commands-svc-ac7-b');
      const command = scriptedActionsCommand([oneValidAction]);

      await service.parse(workspaceA, callingUserActor, command);

      expect(await countProposalRows(workspaceA)).toBe(1);
      expect(await countProposalRows(workspaceB)).toBe(0);
    });
  });
});
