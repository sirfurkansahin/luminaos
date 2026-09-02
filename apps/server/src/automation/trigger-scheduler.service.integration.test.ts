import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionResult, AIProvider } from '@luminaos/ai-gateway';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F2-T15 PR4 (RED step), ADR-0032 Karar (a)/(c) — `TriggerSchedulerService`:
 * the background service that fires `kind: 'scheduled'` triggers (condition/
 * regex triggers are PR5, out of scope here).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./trigger-scheduler.service.ts` does not exist,
 * so the dynamic `import('./trigger-scheduler.service.js')` inside `beforeAll`
 * REJECTS ("Cannot find module"), failing `beforeAll` and thus every `it` in
 * this file — mirrors `meeting-retention-sweeper.integration.test.ts`'s
 * identical "service doesn't exist yet" documented red state. Separately,
 * `CommandsService.proposeFromTrigger`'s 3rd parameter (`sourceObjectId`) is
 * still typed as a required `string` on the real class today (widening it to
 * `string | undefined` is `implementer`'s job, same PR) — this file's local
 * `CommandsServiceContract`/`CommandsServiceConstructor` types declare the
 * WIDENED shape it must have once implemented, and the real `CommandsService`
 * class is loaded via a dynamic import + constructor-type cast (mirroring
 * `commands.service.propose-from-trigger.integration.test.ts`'s own "5-dep
 * lightweight harness" cast trick) so this file compiles/runs today without
 * depending on that widening having already landed.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) for the actual
 * assertions under test, but `CommandsService`'s OWN constructor chain
 * transitively imports `../config/env.ts`, which hard-fails at module load if
 * `REDIS_URL` is unset — so `REDIS_URL` is set to an inert placeholder before
 * that import runs, exactly like `commands.service.propose-from-trigger.
 * integration.test.ts` does. `AIUsageService`/`EventStoreService`/
 * `ProjectionRunner`/`MockProvider` are already-stable, already-merged
 * dependencies with no pending signature changes, so (unlike `CommandsService`)
 * they are imported normally (statically) rather than via the dynamic-import-
 * plus-cast trick — a deliberate divergence from the propose-from-trigger
 * file's own (more uniform) style, since only genuinely-changing/not-yet-
 * existing modules need that indirection.
 *
 * `TriggerSchedulerService` is constructed directly with a real (5-dep
 * "lightweight") `CommandsService` instance — `proposeFromTrigger`/
 * `recordProposal` never touch `objectsService`/`relationsService`/
 * `workspaceMembershipService` (only `decide()`'s execute-* methods do), so
 * those three trailing constructor args are safely omitted, mirroring
 * `commands.service.propose-from-trigger.integration.test.ts`'s own harness
 * exactly.
 *
 * DESIGN judgment calls pinned by this file (not 100% spelled out by the
 * plan) — see the constructor/contract types below for the precise shape
 * `implementer` must produce:
 *   - `TriggerSchedulerService`'s constructor is `(db: Database,
 *     commandsService: CommandsService)` — no optional second-arg pattern
 *     (unlike `MeetingRetentionSweeperService`), since `CommandsService` has
 *     no lightweight zero-arg-constructible default the way
 *     `MeetingRetentionPreferenceService` does.
 *   - A due trigger that FAILS to fire (its `proposeFromTrigger` call throws)
 *     must NOT have its `lastFiredAt` touched at all — a failed fire is
 *     expected to be retried on the NEXT `runOnce()` tick, not silently
 *     marked as fired (test 7 below).
 *   - The service scans the ENTIRE `automation_triggers` table on every
 *     `runOnce()` call (no per-workspace filtering), mirroring
 *     `MeetingRetentionSweeperService.sweepOnce()`'s own table-wide (not
 *     per-workspace) sweep -- so every assertion below is written against a
 *     SPECIFIC triggerId's own resulting state (never a global/workspace-wide
 *     row count), keeping tests order-independent even though they all share
 *     one Postgres container/table.
 * ============================================================================
 */

const SOURCE_OBJECT_ID_TRIPWIRE = '__must-never-be-set__';

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

/**
 * The WIDENED contract `CommandsService.proposeFromTrigger` must have once
 * `implementer` makes this PR's change (`sourceObjectId: string | undefined`,
 * not the real class's current required `string`) — a scheduled trigger has
 * no matched source object at all, so `TriggerSchedulerService` calls this
 * with `undefined` as the 3rd argument.
 */
interface CommandsServiceContract {
  proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string | undefined,
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

interface TriggerSchedulerServiceLike {
  runOnce(): Promise<void>;
}

interface TriggerSchedulerServiceConstructor {
  new (db: Database, commandsService: CommandsServiceContract): TriggerSchedulerServiceLike;
}

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

interface TriggerRow {
  lastFiredAt: Date | null;
  lifecycle: string;
}

const TOKEN_QUOTA_PER_WORKSPACE = 10;
const COST_BUDGET_USD_PER_WORKSPACE = 10;

describe('TriggerSchedulerService (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let commandsService: CommandsServiceContract;
  let TriggerSchedulerService: TriggerSchedulerServiceConstructor;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://trigger-scheduler-test-placeholder:6379';
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = String(TOKEN_QUOTA_PER_WORKSPACE);
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = String(COST_BUDGET_USD_PER_WORKSPACE);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    const aiUsageModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageModule as { AIUsageService: AIUsageServiceConstructor })
      .AIUsageService;
    const aiUsageService = new AIUsageServiceCtor(db, eventStore, projectionRunner);

    // Never expected to be invoked by this flow at all (no AI call in
    // proposeFromTrigger/recordProposal) -- a tripwire body.
    function respond(): AICompletionResult {
      throw new Error(
        'Test bug (or implementer regression): TriggerSchedulerService must never cause provider.complete to be invoked',
      );
    }
    const provider = new MockProvider(respond);

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

    const schedulerModule = (await import('./trigger-scheduler.service.js')) as unknown as {
      TriggerSchedulerService: TriggerSchedulerServiceConstructor;
    };
    TriggerSchedulerService = schedulerModule.TriggerSchedulerService;
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
        name: `trigger-scheduler-test-workspace-${String(workspaceCounter)}`,
        slug: `trigger-scheduler-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  async function insertScheduledTrigger(params: {
    workspaceId: string;
    intervalMinutes: number;
    actionTitle: string;
    lastFiredAt: Date | null;
    lifecycle?: 'active' | 'deleted';
  }): Promise<string> {
    const triggerId = ulid();
    const now = new Date();
    await db.insert(automationTriggers).values({
      id: triggerId,
      streamId: randomUUID(),
      workspaceId: params.workspaceId,
      name: `scheduled-trigger-${triggerId}`,
      kind: 'scheduled',
      spec: {
        kind: 'scheduled',
        intervalMinutes: params.intervalMinutes,
        actionTemplate: { title: params.actionTitle },
      },
      lastFiredAt: params.lastFiredAt,
      lifecycle: params.lifecycle ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
    return triggerId;
  }

  async function insertConditionTrigger(params: { workspaceId: string }): Promise<string> {
    const triggerId = ulid();
    const now = new Date();
    await db.insert(automationTriggers).values({
      id: triggerId,
      streamId: randomUUID(),
      workspaceId: params.workspaceId,
      name: `condition-trigger-${triggerId}`,
      kind: 'condition',
      spec: {
        kind: 'condition',
        objectType: 'task',
        fieldKey: 'status',
        pattern: 'done',
        flags: '',
        actionTemplate: { title: 'Should never be proposed' },
      },
      // A never-fired condition trigger would be "due" under the scheduled
      // math if the scheduler mistakenly treated it as scheduled -- set to
      // null deliberately so a buggy implementation that ignores `kind`
      // would still (wrongly) attempt to fire it, making this a meaningful
      // negative test.
      lastFiredAt: null,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return triggerId;
  }

  async function readTriggerRow(triggerId: string): Promise<TriggerRow | undefined> {
    const [row] = await db
      .select({
        lastFiredAt: automationTriggers.lastFiredAt,
        lifecycle: automationTriggers.lifecycle,
      })
      .from(automationTriggers)
      .where(eq(automationTriggers.id, triggerId));
    return row;
  }

  async function getProposalRowsForTrigger(triggerId: string): Promise<RawCommandProposalRow[]> {
    const result = await db.$client.query<RawCommandProposalRow>(
      'select id, stream_id, workspace_id, command, source_object_id, actions, decisions, created_at, decided_at from command_proposals where command = $1',
      [`[trigger] triggerId=${triggerId}`],
    );
    return result.rows;
  }

  // ---------------------------------------------------------------------
  // 1. never fired (lastFiredAt: null) -> immediately due
  // ---------------------------------------------------------------------

  it('1. a scheduled trigger with lastFiredAt: null (never fired) is immediately due -- runOnce() proposes for it and advances lastFiredAt to a recent timestamp', async () => {
    const workspaceId = await createWorkspace();
    const triggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes: 30,
      actionTitle: 'Never-fired trigger task',
      lastFiredAt: null,
    });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    const beforeRun = Date.now();
    await scheduler.runOnce();

    const proposals = await getProposalRowsForTrigger(triggerId);
    expect(proposals).toHaveLength(1);

    const row = await readTriggerRow(triggerId);
    expect(row?.lastFiredAt).not.toBeNull();
    expect(row?.lastFiredAt?.getTime()).toBeGreaterThanOrEqual(beforeRun - 5_000);
  });

  // ---------------------------------------------------------------------
  // 2. lastFiredAt older than intervalMinutes -> due again
  // ---------------------------------------------------------------------

  it('2. a scheduled trigger whose lastFiredAt is OLDER than intervalMinutes ago is due -- fires again and lastFiredAt advances', async () => {
    const workspaceId = await createWorkspace();
    const intervalMinutes = 5;
    const staleLastFiredAt = new Date(Date.now() - (intervalMinutes + 10) * 60 * 1000);
    const triggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes,
      actionTitle: 'Overdue trigger task',
      lastFiredAt: staleLastFiredAt,
    });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    await scheduler.runOnce();

    const proposals = await getProposalRowsForTrigger(triggerId);
    expect(proposals).toHaveLength(1);

    const row = await readTriggerRow(triggerId);
    expect(row?.lastFiredAt?.getTime()).toBeGreaterThan(staleLastFiredAt.getTime());
  });

  // ---------------------------------------------------------------------
  // 3. lastFiredAt within intervalMinutes -> not due, untouched
  // ---------------------------------------------------------------------

  it('3. a scheduled trigger whose lastFiredAt is WITHIN intervalMinutes does NOT fire -- no proposal created, lastFiredAt unchanged', async () => {
    const workspaceId = await createWorkspace();
    const intervalMinutes = 30;
    const recentLastFiredAt = new Date(Date.now() - 1 * 60 * 1000);
    const triggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes,
      actionTitle: 'Not-yet-due trigger task',
      lastFiredAt: recentLastFiredAt,
    });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    await scheduler.runOnce();

    const proposals = await getProposalRowsForTrigger(triggerId);
    expect(proposals).toHaveLength(0);

    const row = await readTriggerRow(triggerId);
    expect(row?.lastFiredAt?.getTime()).toBe(recentLastFiredAt.getTime());
  });

  // ---------------------------------------------------------------------
  // 4. kind: 'condition' -> completely ignored (out of scope, PR5)
  // ---------------------------------------------------------------------

  it("4. a kind:'condition' trigger is completely ignored by runOnce(), regardless of lastFiredAt", async () => {
    const workspaceId = await createWorkspace();
    const triggerId = await insertConditionTrigger({ workspaceId });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    await scheduler.runOnce();

    const proposals = await getProposalRowsForTrigger(triggerId);
    expect(proposals).toHaveLength(0);

    const row = await readTriggerRow(triggerId);
    expect(row?.lastFiredAt).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 5. lifecycle: 'deleted' -> never fired even if technically "due"
  // ---------------------------------------------------------------------

  it("5. a lifecycle:'deleted' scheduled trigger is never fired, even though it is technically due (lastFiredAt: null)", async () => {
    const workspaceId = await createWorkspace();
    const triggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes: 5,
      actionTitle: 'Deleted trigger task',
      lastFiredAt: null,
      lifecycle: 'deleted',
    });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    await scheduler.runOnce();

    const proposals = await getProposalRowsForTrigger(triggerId);
    expect(proposals).toHaveLength(0);

    const row = await readTriggerRow(triggerId);
    expect(row?.lastFiredAt).toBeNull();
    expect(row?.lifecycle).toBe('deleted');
  });

  // ---------------------------------------------------------------------
  // 6. multiple due triggers across two workspaces ALL fire in one call
  // ---------------------------------------------------------------------

  it('6. multiple due triggers across two different workspaces ALL fire in a single runOnce() call, each with sourceObjectId absent/undefined and command containing its OWN triggerId', async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();

    const triggerA = await insertScheduledTrigger({
      workspaceId: workspaceA,
      intervalMinutes: 15,
      actionTitle: 'Workspace A due task',
      lastFiredAt: null,
    });
    const triggerB = await insertScheduledTrigger({
      workspaceId: workspaceB,
      intervalMinutes: 15,
      actionTitle: 'Workspace B due task',
      lastFiredAt: null,
    });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    await scheduler.runOnce();

    for (const [triggerId, workspaceId] of [
      [triggerA, workspaceA],
      [triggerB, workspaceB],
    ] as const) {
      const proposals = await getProposalRowsForTrigger(triggerId);
      expect(proposals).toHaveLength(1);
      const [proposal] = proposals;
      expect(proposal?.workspace_id).toBe(workspaceId);
      expect(proposal?.source_object_id).toBeNull();
      expect(proposal?.command).toBe(`[trigger] triggerId=${triggerId}`);

      const streamEvents = await eventStore.readStream(proposal?.stream_id ?? '');
      const proposedEvent = streamEvents.find((event) => event.type === 'ActionsProposed');
      const payload = proposedEvent?.payload;
      expect(payload).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(payload, 'sourceObjectId')).toBe(false);
      expect(payload?.['sourceObjectId']).not.toBe(SOURCE_OBJECT_ID_TRIPWIRE);
    }
  });

  // ---------------------------------------------------------------------
  // 7. one trigger's failure never blocks another due trigger in the SAME
  //    runOnce() call, and never marks the failing trigger as fired
  // ---------------------------------------------------------------------

  it("7. one due trigger's proposeFromTrigger call throwing does not prevent ANOTHER due trigger from firing in the same runOnce() call, and does NOT update the failing trigger's lastFiredAt", async () => {
    const workspaceId = await createWorkspace();
    const failingTriggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes: 10,
      actionTitle: 'This one must fail',
      lastFiredAt: null,
    });
    const succeedingTriggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes: 10,
      actionTitle: 'This one must still succeed',
      lastFiredAt: null,
    });

    const spy = vi
      .spyOn(commandsService, 'proposeFromTrigger')
      .mockImplementation(async (wsId, triggerId, sourceObjectId, actions) => {
        if (triggerId === failingTriggerId) {
          throw new Error('Simulated proposeFromTrigger failure for this specific trigger');
        }
        spy.mockRestore();
        try {
          return await commandsService.proposeFromTrigger(wsId, triggerId, sourceObjectId, actions);
        } finally {
          vi.spyOn(commandsService, 'proposeFromTrigger');
        }
      });

    try {
      const scheduler = new TriggerSchedulerService(db, commandsService);
      await expect(scheduler.runOnce()).resolves.toBeUndefined();

      const failingProposals = await getProposalRowsForTrigger(failingTriggerId);
      expect(failingProposals).toHaveLength(0);
      const failingRow = await readTriggerRow(failingTriggerId);
      expect(failingRow?.lastFiredAt).toBeNull();

      const succeedingProposals = await getProposalRowsForTrigger(succeedingTriggerId);
      expect(succeedingProposals).toHaveLength(1);
      const succeedingRow = await readTriggerRow(succeedingTriggerId);
      expect(succeedingRow?.lastFiredAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------
  // 8. the proposed action's params.title matches the fired trigger's own
  //    spec.actionTemplate.title exactly
  // ---------------------------------------------------------------------

  it("8. the proposed action's params.title matches the fired trigger's own spec.actionTemplate.title exactly", async () => {
    const workspaceId = await createWorkspace();
    const distinctiveTitle = `Exact title match check ${randomUUID()}`;
    const triggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes: 20,
      actionTitle: distinctiveTitle,
      lastFiredAt: null,
    });

    const scheduler = new TriggerSchedulerService(db, commandsService);
    await scheduler.runOnce();

    const proposals = await getProposalRowsForTrigger(triggerId);
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    const actions = proposal?.actions as ProposedActionContract[] | undefined;
    expect(actions).toHaveLength(1);
    expect(actions?.[0]?.type).toBe('createTaskFromTrigger');
    expect(actions?.[0]?.params['title']).toBe(distinctiveTitle);
  });
});
