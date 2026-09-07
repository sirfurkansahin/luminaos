import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { agentPermissionManifests } from '../db/schema/agent-permission-manifests.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F3-T3 PR4 (RED step), ADR-0037 §4 — `CommandsService.executeReconfigureAgentPermissions`,
 * dispatched from a NEW `case 'reconfigureAgentPermissions':` in
 * `executeDecidedAction`'s switch, and `CommandsService.decide()`'s own
 * two-layer-defense contract for this action type (ADR-0034/F2-T17's pattern,
 * repeated verbatim: an AI-shaped proposal is NEVER trusted as sufficient
 * authority on its own -- the REAL production service
 * (`AgentPermissionManifestsService.grant`/`.revoke`) re-validates admin+ for
 * real, with the REAL decide()-time approver's own identity/role).
 *
 * Nothing under test here exists yet: `executeReconfigureAgentPermissions`/
 * the `reconfigureAgentPermissions` switch case do not exist on
 * `./commands.service.ts`'s real class today (the switch's current 5
 * branches do not include this 6th one at all -- a TS exhaustiveness error
 * once `DecidableAction['type']` is widened, or a runtime `undefined` return
 * today). `CommandsService.proposeFromDirectMessage` (this PR's OTHER new
 * method, covered in isolation by this PR's sibling file
 * `./commands.service.propose-from-direct-message.integration.test.ts`) is
 * ALSO required for this file's own `beforeAll`/each test's setup step
 * (seeding a decidable proposal) to succeed at all.
 *
 * HARNESS NOTE: deliberately NOT the full-`AppModule`/Redis/HTTP harness that
 * `./commands.service.execute-create-task-from-meeting.integration.test.ts`
 * uses -- that harness exists ONLY because THAT file's action type needs a
 * REAL `ObjectsService.create`/`setFieldValues`. This action type needs
 * neither: `executeReconfigureAgentPermissions` only ever calls
 * `AgentPermissionManifestsService.grant`/`.revoke`, and THAT service's own
 * constructor is just as lightweight as `AIUsageService`'s (`db`/
 * `eventStore`/`projectionRunner`, no further collaborators, see
 * `../agent-runtime/agent-permission-manifests.service.ts`) -- so the
 * Testcontainers-Postgres-only harness (no Redis, no full Nest app, no HTTP)
 * used by `./commands.service.propose-from-meeting.integration.test.ts`/
 * `./commands.service.propose-from-direct-message.integration.test.ts`
 * applies directly here too. `decide()`'s OTHER dispatch branches
 * (`objectsService`/`relationsService`/`workspaceMembershipService`,
 * constructor positions 6/7/8) are entirely untouched by this file's own
 * action type, so they are passed as `undefined` -- never constructed,
 * never exercised, exactly like every OTHER lightweight-harness file in this
 * directory already omits/ignores trailing constructor params its own tests
 * don't reach.
 *
 * `approverActor`/`callerRole` passed into every test's own `decide()` call
 * are literal, directly-constructed values (a synthetic `{type:'user', id:
 * ...}` `Actor` + a role string) -- no HTTP registration/login flow needed,
 * since `decide()`'s signature takes them as plain arguments (unlike the
 * full-AppModule harness, which sources them from a real registered user
 * purely because ITS OWN action type needed a real `ObjectsService`-created
 * object attributable to a real user).
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `executeReconfigureAgentPermissions(workspaceId, action, approverActor,
 * callerRole): Promise<DecideActionResult>`:
 *   - reads `agentIdentifier` (`requireStringParam`) and `operation` from
 *     `action.params`; `operation` must be exactly `'grant'` or `'revoke'`,
 *     anything else -> `ValidationError`, caught by this method's own
 *     try/catch -> `{status:'failed', error}`.
 *   - `operation === 'revoke'`: calls
 *     `agentPermissionManifestsService.revoke(workspaceId, agentIdentifier,
 *     approverActor, callerRole)` -- the REAL decide()-time approver's own
 *     actor/role, NEVER `DM_RECONFIGURATION_ACTOR`.
 *   - `operation === 'grant'`: reads+validates `dataScope`/`actionTypes`/
 *     `timeWindow` from `action.params` (any shape violation ->
 *     `ValidationError`), parses `timeWindow.startsAt`/`.expiresAt` ISO
 *     strings to `Date | null`, calls
 *     `agentPermissionManifestsService.grant(workspaceId, approverActor,
 *     callerRole, {agentIdentifier, dataScope, actionTypes,
 *     timeWindow:{startsAt, expiresAt}})`.
 *   - both branches: whole method body in try/catch ->
 *     `{actionId, status:'executed'}` on success,
 *     `{actionId, status:'failed', error: toErrorMessage(error)}` on any
 *     thrown error (never a raw stack trace / driver-level error text).
 *
 * Since `AgentPermissionManifestsService.grant`/`.revoke` BOTH already throw
 * `ForbiddenError` internally for a non-admin `callerRole` (already-merged
 * F3-T1 behavior, verified directly by
 * `../agent-runtime/agent-permission-manifests.service.integration.test.ts`),
 * a `decide()` call approved by a non-admin real approver must surface as
 * `status:'failed'` here -- proof that the manifest service's OWN admin-gate
 * is what actually blocks it, at decide-time, not proposal-time (AC-critical
 * below).
 * ============================================================================
 */

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

interface DecisionInput {
  actionId: string;
  decision: 'approved' | 'rejected';
}

interface DecideActionResult {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
  error?: string;
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

interface GrantManifestInputContract {
  agentIdentifier: string;
  dataScope: { objectTypes: string[] | 'all' };
  actionTypes: string[];
  timeWindow: { startsAt: Date | null; expiresAt: Date | null };
}

/** The real `AgentPermissionManifestsService` public contract (already
 * merged, F3-T1) -- declared locally, same reasoning as every other file in
 * this directory. */
interface AgentPermissionManifestsServiceContract {
  grant(
    workspaceId: string,
    actor: Actor,
    callerRole: 'owner' | 'admin' | 'member' | 'guest',
    input: GrantManifestInputContract,
  ): Promise<unknown>;
  revoke(
    workspaceId: string,
    agentIdentifier: string,
    actor: Actor,
    callerRole: 'owner' | 'admin' | 'member' | 'guest',
  ): Promise<unknown>;
}

type AgentPermissionManifestsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AgentPermissionManifestsServiceContract;

/** The public contract `CommandsService` must satisfy once `implementer` adds
 * `proposeFromDirectMessage`/`executeReconfigureAgentPermissions` --
 * declared locally, same reasoning as every other file in this directory. */
interface CommandsServiceContract {
  proposeFromDirectMessage(
    workspaceId: string,
    actor: Actor,
    callerRole: 'owner' | 'admin' | 'member' | 'guest',
    agentIdentifier: string,
    dmMessageText: string,
  ): Promise<CommandsServiceParseResult>;
  decide(
    workspaceId: string,
    proposalId: string,
    approverActor: Actor,
    callerRole: 'owner' | 'admin' | 'member' | 'guest',
    decisions: DecisionInput[],
  ): Promise<{ results: DecideActionResult[] }>;
}

/** Same 9-arg constructor shape this PR's task description pins
 * (`agentPermissionManifestsService` added at the END, after the existing 8)
 * -- positions 6/7/8 (`objectsService`/`relationsService`/
 * `workspaceMembershipService`) are declared `unknown` and passed `undefined`
 * below, since this file's own action type never reaches them. */
type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageServiceContract,
  aiProvider: AIProvider,
  objectsService: unknown,
  relationsService: unknown,
  workspaceMembershipService: unknown,
  agentPermissionManifestsService: AgentPermissionManifestsServiceContract,
) => CommandsServiceContract;

describe('CommandsService.executeReconfigureAgentPermissions() via decide() (F3-T3 PR4, real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let aiUsageService: AIUsageServiceContract;
  let agentPermissionManifestsService: AgentPermissionManifestsServiceContract;
  let provider: MockProvider;
  let service: CommandsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://execute-reconfigure-test-placeholder:6379';
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

    const agentPermissionManifestsModule: unknown =
      await import('../agent-runtime/agent-permission-manifests.service.js');
    const AgentPermissionManifestsServiceCtor = (
      agentPermissionManifestsModule as {
        AgentPermissionManifestsService: AgentPermissionManifestsServiceConstructor;
      }
    ).AgentPermissionManifestsService;
    agentPermissionManifestsService = new AgentPermissionManifestsServiceCtor(
      db,
      eventStore,
      projectionRunner,
    );

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

    const commandsModule: unknown = await import('./commands.service.js');
    const CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;
    service = new CommandsServiceCtor(
      db,
      eventStore,
      projectionRunner,
      aiUsageService,
      provider,
      undefined,
      undefined,
      undefined,
      agentPermissionManifestsService,
    );
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

  function scriptedDmMessage(actions: Record<string, unknown>[]): string {
    return `Please reconfigure the agent. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function reconfigureActionJson(params: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'reconfigureAgentPermissions',
      intent: 'Reconfigure agent permissions per the DM request',
      rationale: 'The user explicitly requested this via DM',
      resources: [typeof params.agentIdentifier === 'string' ? params.agentIdentifier : 'unknown'],
      rollbackNote: 'Reverse the grant/revoke if this was a mistake',
      params,
    };
  }

  /** `proposeFromDirectMessage()` a scripted DM message and assert it
   * succeeded -- the shared proposal-setup step every test below needs
   * before it can call `decide()`. Mirrors
   * `commands.service.execute-create-task-from-meeting.integration.test.ts`'s
   * own `proposeFromMeetingAndGetActions` convention. */
  async function proposeReconfigurationAndGetActionId(
    workspaceId: string,
    adminActor: Actor,
    agentIdentifier: string,
    params: Record<string, unknown>,
  ): Promise<{ proposalId: string; actionId: string }> {
    const dmMessageText = scriptedDmMessage([reconfigureActionJson(params)]);
    const result = await service.proposeFromDirectMessage(
      workspaceId,
      adminActor,
      'admin',
      agentIdentifier,
      dmMessageText,
    );
    expect(result.parseError).toBe(false);
    const actionId = result.actions[0]?.actionId;
    if (actionId === undefined) {
      throw new Error('Test bug: expected exactly one parsed action');
    }
    return { proposalId: result.proposalId, actionId };
  }

  async function getManifestRow(workspaceId: string, agentIdentifier: string) {
    const [row] = await db
      .select()
      .from(agentPermissionManifests)
      .where(
        and(
          eq(agentPermissionManifests.workspaceId, workspaceId),
          eq(agentPermissionManifests.agentIdentifier, agentIdentifier),
        ),
      )
      .limit(1);
    return row;
  }

  // ---------------------------------------------------------------------
  // AC5 -- grant round-trip
  // ---------------------------------------------------------------------

  describe('AC5: a valid grant reconfiguration, decided by a real admin approver', () => {
    it('reports executed AND a real agent_permission_manifests row now exists with the exact requested fields', async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac5-grant');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'grant-agent-ac5';

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        {
          agentIdentifier,
          operation: 'grant',
          dataScope: { objectTypes: 'all' },
          actionTypes: ['answer-question'],
          timeWindow: { startsAt: null, expiresAt: null },
        },
      );

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const row = await getManifestRow(workspaceId, agentIdentifier);
      expect(row).toBeDefined();
      expect(row?.actionTypes).toEqual(['answer-question']);
      expect(row?.dataScope).toEqual({ objectTypes: 'all' });
      expect(row?.startsAt).toBeNull();
      expect(row?.expiresAt).toBeNull();
      expect(row?.revokedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC6 -- revoke round-trip (against a manifest seeded directly via
  // AgentPermissionManifestsService.grant)
  // ---------------------------------------------------------------------

  describe('AC6: a valid revoke reconfiguration against an agent with an active manifest, decided by a real admin approver', () => {
    it('reports executed AND the existing manifest row now has a non-null revokedAt', async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac6-revoke');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'revoke-agent-ac6';

      await agentPermissionManifestsService.grant(workspaceId, adminActor, 'admin', {
        agentIdentifier,
        dataScope: { objectTypes: 'all' },
        actionTypes: ['answer-question'],
        timeWindow: { startsAt: null, expiresAt: null },
      });

      const beforeRow = await getManifestRow(workspaceId, agentIdentifier);
      expect(beforeRow?.revokedAt).toBeNull();

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        { agentIdentifier, operation: 'revoke' },
      );

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const afterRow = await getManifestRow(workspaceId, agentIdentifier);
      expect(afterRow?.revokedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC-critical -- approverActor/callerRole passed to grant/revoke are ALWAYS
  // the real decide()-time approver, NEVER DM_RECONFIGURATION_ACTOR
  // ---------------------------------------------------------------------

  describe('AC-critical: the REAL decide()-time approver identity/role reaches AgentPermissionManifestsService.grant, never a fixed system actor', () => {
    it('agentPermissionManifestsService.grant is called with the exact approverActor/callerRole passed into decide()', async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac-critical');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'grant-agent-ac-critical';

      const grantSpy = vi.spyOn(agentPermissionManifestsService, 'grant');

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        {
          agentIdentifier,
          operation: 'grant',
          dataScope: { objectTypes: 'all' },
          actionTypes: ['answer-question'],
          timeWindow: { startsAt: null, expiresAt: null },
        },
      );

      await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);

      expect(grantSpy).toHaveBeenCalledWith(
        workspaceId,
        adminActor,
        'admin',
        expect.objectContaining({ agentIdentifier }),
      );
      // The DM's own fixed proposal-source actor must NEVER be the one
      // passed to the real production service.
      expect(grantSpy).not.toHaveBeenCalledWith(
        workspaceId,
        { type: 'agent', id: 'dm-reconfiguration-parser' },
        expect.anything(),
        expect.anything(),
      );

      grantSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------
  // AC7 -- decide-time re-validation actually fires: a NON-admin approver
  // ---------------------------------------------------------------------

  describe('AC7: the SAME valid grant reconfiguration, decided by a NON-admin approver', () => {
    it("reports failed (AgentPermissionManifestsService.grant's own admin-gate fires at decide-time) AND no manifest is created", async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac7-non-admin');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const memberActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'grant-agent-ac7';

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        {
          agentIdentifier,
          operation: 'grant',
          dataScope: { objectTypes: 'all' },
          actionTypes: ['answer-question'],
          timeWindow: { startsAt: null, expiresAt: null },
        },
      );

      const { results } = await service.decide(workspaceId, proposalId, memberActor, 'member', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });
      expect(typeof results[0]?.error).toBe('string');

      const row = await getManifestRow(workspaceId, agentIdentifier);
      expect(row).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC8 -- malformed grant params at decide-time: clean, non-leaking error
  // ---------------------------------------------------------------------

  describe('AC8a: a grant reconfiguration whose dataScope.objectTypes is neither an array nor "all"', () => {
    it('reports failed with a clean, non-leaking error message, and no manifest is created', async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac8a-bad-datascope');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'grant-agent-ac8a';

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        {
          agentIdentifier,
          operation: 'grant',
          dataScope: { objectTypes: 'not-a-valid-value' },
          actionTypes: ['answer-question'],
          timeWindow: { startsAt: null, expiresAt: null },
        },
      );

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });
      expect(typeof results[0]?.error).toBe('string');
      expect(results[0]?.error).not.toMatch(/at Object|node_modules|\.ts:\d+/);

      const row = await getManifestRow(workspaceId, agentIdentifier);
      expect(row).toBeUndefined();
    });
  });

  describe('AC8b: a grant reconfiguration whose timeWindow.startsAt is an unparseable string', () => {
    it('reports failed with a clean, non-leaking error message, and no manifest is created', async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac8b-bad-timewindow');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'grant-agent-ac8b';

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        {
          agentIdentifier,
          operation: 'grant',
          dataScope: { objectTypes: 'all' },
          actionTypes: ['answer-question'],
          timeWindow: { startsAt: 'not-a-real-date', expiresAt: null },
        },
      );

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });
      expect(typeof results[0]?.error).toBe('string');

      const row = await getManifestRow(workspaceId, agentIdentifier);
      expect(row).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC9 -- unknown operation value
  // ---------------------------------------------------------------------

  describe('AC9: an unknown/garbage operation value (neither "grant" nor "revoke")', () => {
    it('reports failed, and neither grant nor revoke is ever called', async () => {
      const workspaceId = await createWorkspace('execute-reconfigure-ac9-bad-operation');
      const adminActor: Actor = { type: 'user', id: crypto.randomUUID() };
      const agentIdentifier = 'grant-agent-ac9';

      const grantSpy = vi.spyOn(agentPermissionManifestsService, 'grant');
      const revokeSpy = vi.spyOn(agentPermissionManifestsService, 'revoke');
      const grantCallsBefore = grantSpy.mock.calls.length;
      const revokeCallsBefore = revokeSpy.mock.calls.length;

      const { proposalId, actionId } = await proposeReconfigurationAndGetActionId(
        workspaceId,
        adminActor,
        agentIdentifier,
        { agentIdentifier, operation: 'destroy-everything' },
      );

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });
      expect(grantSpy.mock.calls.length).toBe(grantCallsBefore);
      expect(revokeSpy.mock.calls.length).toBe(revokeCallsBefore);

      grantSpy.mockRestore();
      revokeSpy.mockRestore();
    });
  });
});
