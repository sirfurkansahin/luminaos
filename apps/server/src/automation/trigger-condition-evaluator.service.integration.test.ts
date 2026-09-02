import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { automationTriggerMatches } from '../db/schema/automation-trigger-matches.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F2-T15 PR5 (RED step), ADR-0032 Karar (a)/(b)/(g)/(j)/(k) —
 * `TriggerConditionEvaluatorService`: the background service that fires
 * `kind: 'condition'` (regex) triggers by polling `objects_view` on a fixed
 * interval, diffing the current matching object-id set against the
 * previously-recorded one in `automation_trigger_matches` (a falling edge
 * re-arms the trigger).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./trigger-condition-evaluator.service.ts` does
 * not exist, so the dynamic `import('./trigger-condition-evaluator.service.js')`
 * inside `beforeAll` REJECTS ("Cannot find module"), failing `beforeAll` and
 * thus every `it` in this file — mirrors `trigger-scheduler.service.
 * integration.test.ts`'s (PR4) identical documented red state.
 *
 * HARNESS: identical style to `trigger-scheduler.service.integration.test.ts`
 * (PR4) — Testcontainers Postgres ONLY (no Redis/HTTP for the assertions
 * under test, though `REDIS_URL` is still set to an inert placeholder before
 * `CommandsService`'s constructor chain is imported, since that chain
 * transitively hard-fails at module load if `REDIS_URL` is unset). A real
 * 5-dep "lightweight" `CommandsService` is constructed directly (never
 * touches `objectsService`/`relationsService`/`workspaceMembershipService`,
 * since `proposeFromTrigger`/`recordProposal` don't need them — only
 * `decide()`'s execute-* methods do, which are out of scope here). The
 * not-yet-existing `TriggerConditionEvaluatorService` is loaded via a dynamic
 * import + constructor-type cast; already-stable/already-merged dependencies
 * (`AIUsageService`/`EventStoreService`/`ProjectionRunner`/`MockProvider`) are
 * imported normally (statically).
 *
 * DESIGN judgment calls pinned by this file (constructor/contract shape
 * `implementer` must produce, per the task's own suggested sketch):
 *
 *   - `TriggerConditionEvaluatorService`'s constructor is `(db: Database,
 *     commandsService: CommandsService)` — identical 2-arg shape to
 *     `TriggerSchedulerService` (PR4), no optional second-arg pattern.
 *   - The public, directly-callable method under test is `evaluateOnce():
 *     Promise<void>` (this service's analogue of `TriggerSchedulerService.
 *     runOnce()`) — per ADR-0032 Karar (n), `onModuleInit()` is NEVER called
 *     in this file (it would leak a live `setInterval` into the test
 *     process); only `evaluateOnce()` is exercised.
 *   - A condition-trigger's candidate object set is scoped to `workspaceId +
 *     spec.objectType + lifecycle != 'deleted'` (ADR-0032 Karar b/m) — a
 *     field value is read from `objects_view.field_values[spec.fieldKey]`,
 *     NEVER a built-in column.
 *   - The "live field definition" precondition (Karar g) is checked against
 *     `field_definitions` scoped to `(workspaceId, objectType, key,
 *     lifecycle: 'active')` — if absent, the WHOLE trigger is skipped for
 *     that tick (not merely "counts as non-matching").
 *   - Anti-runaway cap (Karar j, N=50, human-approved): a tick that would
 *     insert MORE THAN 50 new match rows for a single trigger is entirely
 *     rejected for THAT trigger (no match rows, no proposals for ANY of that
 *     tick's newly-matching objects) and logged via `Logger.warn` with only
 *     the opaque `triggerId` + match count — the trigger stays `active` and
 *     is retried (from scratch) on the next tick. This must not affect other
 *     triggers evaluated in the same `evaluateOnce()` call.
 *   - Isolation: a per-TRIGGER try/catch (one trigger's total failure must
 *     never abort evaluation of other triggers in the same tick) AND a
 *     per-OBJECT try/catch within one trigger's own newly-matching set (one
 *     object's `proposeFromTrigger` failing must not prevent OTHER
 *     newly-matching objects of the SAME trigger from still getting their own
 *     proposal + match row in the same tick; the failing object's match row
 *     must NOT be inserted, so it is retried as "newly matching" on the next
 *     tick).
 *   - Every assertion below is written against a SPECIFIC (triggerId,
 *     objectId) pair's own resulting state (never a global/workspace-wide row
 *     count), keeping tests order-independent even though they all share one
 *     Postgres container/table — mirrors `trigger-scheduler.service.
 *     integration.test.ts`'s own discipline.
 * ============================================================================
 */

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

/** The already-widened (PR4) contract `CommandsService.proposeFromTrigger`
 * has today — a condition-trigger match ALWAYS has a real matched object, so
 * this service always calls it with a real string, but the contract itself
 * stays `string | undefined` to match the real class's own signature. */
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

interface TriggerConditionEvaluatorServiceLike {
  evaluateOnce(): Promise<void>;
}

interface TriggerConditionEvaluatorServiceConstructor {
  new (
    db: Database,
    commandsService: CommandsServiceContract,
  ): TriggerConditionEvaluatorServiceLike;
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

const TOKEN_QUOTA_PER_WORKSPACE = 10;
const COST_BUDGET_USD_PER_WORKSPACE = 10;
const EDIT_ALL_PERMISSIONS = { owner: 'edit', admin: 'edit', member: 'edit', guest: 'edit' };
const RUNAWAY_MATCH_COUNT = 51;

describe('TriggerConditionEvaluatorService (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let commandsService: CommandsServiceContract;
  let TriggerConditionEvaluatorService: TriggerConditionEvaluatorServiceConstructor;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://trigger-condition-evaluator-test-placeholder:6379';
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
        'Test bug (or implementer regression): TriggerConditionEvaluatorService must never cause provider.complete to be invoked',
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

    const evaluatorModule =
      (await import('./trigger-condition-evaluator.service.js')) as unknown as {
        TriggerConditionEvaluatorService: TriggerConditionEvaluatorServiceConstructor;
      };
    TriggerConditionEvaluatorService = evaluatorModule.TriggerConditionEvaluatorService;
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
        name: `trigger-condition-evaluator-test-workspace-${String(workspaceCounter)}`,
        slug: `trigger-condition-evaluator-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  async function insertConditionTrigger(params: {
    workspaceId: string;
    objectType?: string;
    fieldKey?: string;
    pattern: string;
    flags?: string;
    actionTitle: string;
    lifecycle?: 'active' | 'deleted';
  }): Promise<string> {
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
        objectType: params.objectType ?? 'task',
        fieldKey: params.fieldKey ?? 'status',
        pattern: params.pattern,
        flags: params.flags ?? '',
        actionTemplate: { title: params.actionTitle },
      },
      lastFiredAt: null,
      lifecycle: params.lifecycle ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
    return triggerId;
  }

  async function insertScheduledTrigger(params: {
    workspaceId: string;
    intervalMinutes: number;
    actionTitle: string;
    lastFiredAt: Date | null;
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
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return triggerId;
  }

  async function insertFieldDefinition(params: {
    workspaceId: string;
    objectType?: string;
    key?: string;
    lifecycle?: 'active' | 'deleted';
  }): Promise<string> {
    const fieldDefinitionId = newObjectId();
    const now = new Date();
    await db.insert(fieldDefinitions).values({
      id: fieldDefinitionId,
      streamId: randomUUID(),
      workspaceId: params.workspaceId,
      objectType: params.objectType ?? 'task',
      key: params.key ?? 'status',
      label: 'Status',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
      lifecycle: params.lifecycle ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
    return fieldDefinitionId;
  }

  async function insertObject(params: {
    workspaceId: string;
    objectType?: string;
    fieldValues: Record<string, unknown>;
    lifecycle?: 'active' | 'deleted';
  }): Promise<string> {
    const objectId = newObjectId();
    const now = new Date();
    await db.insert(objectsView).values({
      id: objectId,
      streamId: randomUUID(),
      type: params.objectType ?? 'task',
      workspaceId: params.workspaceId,
      title: `condition-evaluator-test-object-${objectId}`,
      createdBy: 'trigger-condition-evaluator-test-harness',
      createdAt: now,
      updatedAt: now,
      lifecycle: params.lifecycle ?? 'active',
      fieldValues: params.fieldValues,
    });
    return objectId;
  }

  async function updateObjectFieldValues(
    objectId: string,
    fieldValues: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(objectsView)
      .set({ fieldValues, updatedAt: new Date() })
      .where(eq(objectsView.id, objectId));
  }

  async function readMatchRow(
    triggerId: string,
    objectId: string,
  ): Promise<{ triggerId: string; objectId: string } | undefined> {
    const [row] = await db
      .select({
        triggerId: automationTriggerMatches.triggerId,
        objectId: automationTriggerMatches.objectId,
      })
      .from(automationTriggerMatches)
      .where(
        and(
          eq(automationTriggerMatches.triggerId, triggerId),
          eq(automationTriggerMatches.objectId, objectId),
        ),
      );
    return row;
  }

  async function readTriggerLifecycle(triggerId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ lifecycle: automationTriggers.lifecycle })
      .from(automationTriggers)
      .where(eq(automationTriggers.id, triggerId));
    return row?.lifecycle;
  }

  async function getProposalRowsForTrigger(triggerId: string): Promise<RawCommandProposalRow[]> {
    const result = await db.$client.query<RawCommandProposalRow>(
      'select id, stream_id, workspace_id, command, source_object_id, actions, decisions, created_at, decided_at from command_proposals where command = $1',
      [`[trigger] triggerId=${triggerId}`],
    );
    return result.rows;
  }

  async function getProposalRowsForTriggerAndObject(
    triggerId: string,
    objectId: string,
  ): Promise<RawCommandProposalRow[]> {
    const rows = await getProposalRowsForTrigger(triggerId);
    return rows.filter((row) => row.source_object_id === objectId);
  }

  // ---------------------------------------------------------------------
  // 1. matching object -> fires + inserts a match row
  // ---------------------------------------------------------------------

  it('1. an object whose field value matches a condition-trigger pattern/flags fires exactly one proposeFromTrigger call for it, and inserts a matching row into automation_trigger_matches', async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC1: follow up on done task',
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();

    const proposals = await getProposalRowsForTriggerAndObject(triggerId, objectId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.source_object_id).toBe(objectId);
    expect(proposals[0]?.command).toBe(`[trigger] triggerId=${triggerId}`);

    expect(await readMatchRow(triggerId, objectId)).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // 2. non-matching object -> no proposal, no match row
  // ---------------------------------------------------------------------

  it('2. an object whose field value does NOT match the pattern produces no proposal and no match row', async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC2: should never fire',
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'todo' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();

    expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(0);
    expect(await readMatchRow(triggerId, objectId)).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 3. re-running with the same still-matching object -> no duplicate
  // ---------------------------------------------------------------------

  it('3. re-running evaluateOnce() a second time with the SAME still-matching object does NOT fire a second proposal (still-matching = no-op)', async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC3: still matching task',
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();
    await evaluator.evaluateOnce();

    expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(1);
    expect(await readMatchRow(triggerId, objectId)).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // 4. falling edge: matched then un-matched -> match row deleted, no
  //    proposal for the un-match itself
  // ---------------------------------------------------------------------

  it('4. an object that matched on tick 1 then no longer matches on tick 2 (field value changed) has its automation_trigger_matches row deleted, and no new proposal is fired for the un-match itself', async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC4: falling edge task',
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();
    expect(await readMatchRow(triggerId, objectId)).toBeDefined();
    expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(1);

    await updateObjectFieldValues(objectId, { status: 'todo' });
    await evaluator.evaluateOnce();

    expect(await readMatchRow(triggerId, objectId)).toBeUndefined();
    // Still exactly the one proposal from tick 1 -- the un-match itself never
    // fires anything.
    expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // 5. re-arm: un-matched then matches again -> a second proposal
  // ---------------------------------------------------------------------

  it('5. an object that un-matched then matches AGAIN on a later tick fires a SECOND proposal for it (falling-edge re-arms) -- 2 total proposals across the whole test for that object+trigger pair', async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC5: re-arm task',
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce(); // tick 1: matches, fires (1st proposal)
    await updateObjectFieldValues(objectId, { status: 'todo' });
    await evaluator.evaluateOnce(); // tick 2: un-matches, match row deleted
    await updateObjectFieldValues(objectId, { status: 'done' });
    await evaluator.evaluateOnce(); // tick 3: matches again, fires again (2nd proposal)

    const proposals = await getProposalRowsForTriggerAndObject(triggerId, objectId);
    expect(proposals).toHaveLength(2);
    expect(await readMatchRow(triggerId, objectId)).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // 6. missing/deleted field definition -> whole trigger skipped, no crash
  // ---------------------------------------------------------------------

  it('6. a condition-trigger whose objectType/fieldKey combo has NO live field_definitions row (never existed, or was deleted) is completely skipped -- no crash, no proposal, regardless of any matching objects_view rows', async () => {
    const workspaceId = await createWorkspace();

    // Sub-case A: field definition never existed at all.
    const neverExistedTriggerId = await insertConditionTrigger({
      workspaceId,
      fieldKey: 'never_defined_field',
      pattern: '^done$',
      actionTitle: 'AC6a: should never fire, no field def at all',
    });
    const neverExistedObjectId = await insertObject({
      workspaceId,
      fieldValues: { never_defined_field: 'done' },
    });

    // Sub-case B: field definition exists but is lifecycle:'deleted'.
    await insertFieldDefinition({ workspaceId, key: 'deleted_field', lifecycle: 'deleted' });
    const deletedFieldTriggerId = await insertConditionTrigger({
      workspaceId,
      fieldKey: 'deleted_field',
      pattern: '^done$',
      actionTitle: 'AC6b: should never fire, field def deleted',
    });
    const deletedFieldObjectId = await insertObject({
      workspaceId,
      fieldValues: { deleted_field: 'done' },
    });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await expect(evaluator.evaluateOnce()).resolves.toBeUndefined();

    expect(
      await getProposalRowsForTriggerAndObject(neverExistedTriggerId, neverExistedObjectId),
    ).toHaveLength(0);
    expect(await readMatchRow(neverExistedTriggerId, neverExistedObjectId)).toBeUndefined();

    expect(
      await getProposalRowsForTriggerAndObject(deletedFieldTriggerId, deletedFieldObjectId),
    ).toHaveLength(0);
    expect(await readMatchRow(deletedFieldTriggerId, deletedFieldObjectId)).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 7. kind:'scheduled' triggers are never touched by this service
  // ---------------------------------------------------------------------

  it("7. a kind:'scheduled' trigger is never touched by evaluateOnce() at all -- this service only processes kind:'condition'", async () => {
    const workspaceId = await createWorkspace();
    const scheduledTriggerId = await insertScheduledTrigger({
      workspaceId,
      intervalMinutes: 5,
      actionTitle: 'AC7: scheduled, not condition',
      lastFiredAt: null,
    });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();

    expect(await getProposalRowsForTrigger(scheduledTriggerId)).toHaveLength(0);
    const [row] = await db
      .select({ lastFiredAt: automationTriggers.lastFiredAt })
      .from(automationTriggers)
      .where(eq(automationTriggers.id, scheduledTriggerId));
    expect(row?.lastFiredAt).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 8. lifecycle:'deleted' condition-triggers are never evaluated
  // ---------------------------------------------------------------------

  it("8. a lifecycle:'deleted' condition-trigger is never evaluated, even though its own object would otherwise match", async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC8: deleted trigger, never fires',
      lifecycle: 'deleted',
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();

    expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(0);
    expect(await readMatchRow(triggerId, objectId)).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 9. anti-runaway cap: N=50 -- more than 50 new matches rejects the WHOLE
  //    tick for that trigger, retried (not blacklisted) on later ticks
  // ---------------------------------------------------------------------

  it('9. anti-runaway: a condition-trigger whose pattern would newly-match MORE than 50 objects in a single tick has that ENTIRE tick rejected (no proposals/match rows for any of them), the trigger stays lifecycle:active, a SUBSEQUENT tick with the same >50 matching state is rejected again (not permanently blacklisted), and once the matching set shrinks to <=50 it succeeds normally', async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC9: runaway task',
    });

    const objectIds: string[] = [];
    for (let index = 0; index < RUNAWAY_MATCH_COUNT; index += 1) {
      objectIds.push(await insertObject({ workspaceId, fieldValues: { status: 'done' } }));
    }

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);

    // Tick 1: 51 newly-matching objects -> rejected entirely.
    await evaluator.evaluateOnce();
    for (const objectId of objectIds) {
      expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(0);
      expect(await readMatchRow(triggerId, objectId)).toBeUndefined();
    }
    expect(await readTriggerLifecycle(triggerId)).toBe('active');

    // Tick 2: SAME >50 matching state -- rejected again, not blacklisted.
    await evaluator.evaluateOnce();
    for (const objectId of objectIds) {
      expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(0);
    }
    expect(await readTriggerLifecycle(triggerId)).toBe('active');

    // Shrink the matching set to 49 (<=50) -> tick 3 succeeds normally for
    // all still-matching objects.
    await updateObjectFieldValues(objectIds[0] ?? '', { status: 'todo' });
    await updateObjectFieldValues(objectIds[1] ?? '', { status: 'todo' });
    await evaluator.evaluateOnce();

    const stillMatchingIds = objectIds.slice(2);
    for (const objectId of stillMatchingIds) {
      expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(1);
      expect(await readMatchRow(triggerId, objectId)).toBeDefined();
    }
    const unmatchedIds = objectIds.slice(0, 2);
    for (const objectId of unmatchedIds) {
      expect(await getProposalRowsForTriggerAndObject(triggerId, objectId)).toHaveLength(0);
      expect(await readMatchRow(triggerId, objectId)).toBeUndefined();
    }
  }, 60_000);

  // ---------------------------------------------------------------------
  // 10. one object's proposeFromTrigger failure never blocks another
  //     newly-matching object of the SAME trigger in the same tick
  // ---------------------------------------------------------------------

  it("10. one newly-matching object's proposeFromTrigger call throwing does not prevent ANOTHER newly-matching object of the SAME trigger from still getting its own proposal+match-row in the same evaluateOnce() call, and the failing object's match row is NOT inserted (retried as newly-matching next tick)", async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: 'AC10: partial failure task',
    });
    const failingObjectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });
    const succeedingObjectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const spy = vi
      .spyOn(commandsService, 'proposeFromTrigger')
      .mockImplementation(async (wsId, trigId, sourceObjectId, actions) => {
        if (sourceObjectId === failingObjectId) {
          throw new Error('Simulated proposeFromTrigger failure for this specific object');
        }
        spy.mockRestore();
        try {
          return await commandsService.proposeFromTrigger(wsId, trigId, sourceObjectId, actions);
        } finally {
          vi.spyOn(commandsService, 'proposeFromTrigger');
        }
      });

    try {
      const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
      await expect(evaluator.evaluateOnce()).resolves.toBeUndefined();

      expect(await getProposalRowsForTriggerAndObject(triggerId, failingObjectId)).toHaveLength(0);
      expect(await readMatchRow(triggerId, failingObjectId)).toBeUndefined();

      expect(await getProposalRowsForTriggerAndObject(triggerId, succeedingObjectId)).toHaveLength(
        1,
      );
      expect(await readMatchRow(triggerId, succeedingObjectId)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------
  // 11. two different condition-triggers evaluated independently in the
  //     same call, cross-workspace isolation
  // ---------------------------------------------------------------------

  it('11. two different condition-triggers (in different workspaces) are both evaluated independently and correctly in the same evaluateOnce() call -- a trigger in workspace A never matches against objects in workspace B', async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    await insertFieldDefinition({ workspaceId: workspaceA });
    await insertFieldDefinition({ workspaceId: workspaceB });

    const triggerA = await insertConditionTrigger({
      workspaceId: workspaceA,
      pattern: '^done$',
      actionTitle: 'AC11: workspace A task',
    });
    const triggerB = await insertConditionTrigger({
      workspaceId: workspaceB,
      pattern: '^done$',
      actionTitle: 'AC11: workspace B task',
    });

    const objectA = await insertObject({
      workspaceId: workspaceA,
      fieldValues: { status: 'done' },
    });
    const objectB = await insertObject({
      workspaceId: workspaceB,
      fieldValues: { status: 'done' },
    });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();

    const proposalsA = await getProposalRowsForTriggerAndObject(triggerA, objectA);
    expect(proposalsA).toHaveLength(1);
    expect(proposalsA[0]?.workspace_id).toBe(workspaceA);

    const proposalsB = await getProposalRowsForTriggerAndObject(triggerB, objectB);
    expect(proposalsB).toHaveLength(1);
    expect(proposalsB[0]?.workspace_id).toBe(workspaceB);

    // Cross-workspace: triggerA must never match objectB and vice versa.
    expect(await getProposalRowsForTriggerAndObject(triggerA, objectB)).toHaveLength(0);
    expect(await getProposalRowsForTriggerAndObject(triggerB, objectA)).toHaveLength(0);
    expect(await readMatchRow(triggerA, objectB)).toBeUndefined();
    expect(await readMatchRow(triggerB, objectA)).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 12. proposed action shape: params.title === trigger's own
  //     actionTemplate.title, type === 'createTaskFromTrigger'
  // ---------------------------------------------------------------------

  it("12. the proposed action's params.title matches the fired trigger's own spec.actionTemplate.title exactly, and type is 'createTaskFromTrigger'", async () => {
    const workspaceId = await createWorkspace();
    await insertFieldDefinition({ workspaceId });
    const distinctiveTitle = `AC12: exact title match check ${randomUUID()}`;
    const triggerId = await insertConditionTrigger({
      workspaceId,
      pattern: '^done$',
      actionTitle: distinctiveTitle,
    });
    const objectId = await insertObject({ workspaceId, fieldValues: { status: 'done' } });

    const evaluator = new TriggerConditionEvaluatorService(db, commandsService);
    await evaluator.evaluateOnce();

    const proposals = await getProposalRowsForTriggerAndObject(triggerId, objectId);
    expect(proposals).toHaveLength(1);
    const actions = proposals[0]?.actions as ProposedActionContract[] | undefined;
    expect(actions).toHaveLength(1);
    expect(actions?.[0]?.type).toBe('createTaskFromTrigger');
    expect(actions?.[0]?.params['title']).toBe(distinctiveTitle);
  });
});
