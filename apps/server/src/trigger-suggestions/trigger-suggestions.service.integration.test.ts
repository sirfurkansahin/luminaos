import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionResult, AIProvider } from '@luminaos/ai-gateway';
import type { TriggerSpec } from '@luminaos/automation';
import { ConflictError, ForbiddenError, NotFoundError, QuotaExceededError } from '@luminaos/shared';
import type { Actor, NewDomainEvent, Projection } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { aiUsageRecords } from '../db/schema/ai-usage.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';
import { triggerSuggestionAnalysisState } from '../db/schema/trigger-suggestion-analysis-state.js';
import { triggerTemplateSuggestions } from '../db/schema/trigger-template-suggestions.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { AutomationTriggersService } from '../automation/automation-triggers.service.js';
import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F2-T17 PR2 (RED step), ADR-0034 — `TriggerSuggestionsService`: `list`
 * (member+, Karar a), `runAnalysis` (admin+, cooldown Karar b, dry-run filter
 * Karar f layer 1, dedup+cap Karar h, AI quota/lock integration), `decide`
 * (admin+, approve -> REAL `AutomationTriggersService.create` Karar f layer
 * 2/g, reject -> status-only update).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./trigger-suggestions.service.ts` and
 * `./trigger-suggestions.projection.ts` do not exist at all, so the dynamic
 * `import('./trigger-suggestions.service.js')` / `import('./trigger-suggestions.
 * projection.js')` calls inside `beforeAll`/helpers below REJECT ("Cannot find
 * module"), failing every `it` in this file -- mirrors `trigger-scheduler.
 * service.integration.test.ts`'s identical "service doesn't exist yet"
 * documented red state. `trigger_template_suggestions`/
 * `trigger_suggestion_analysis_state` (PR1, merged) already exist as tables --
 * only the service/projection layer is missing.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP). `AIUsageService`/
 * `CommandsService` both transitively import `../config/env.ts`, which
 * hard-fails at module load if `REDIS_URL` is unset -- so `REDIS_URL` is set to
 * an inert placeholder before those modules are (dynamically) imported, exactly
 * like `trigger-scheduler.service.integration.test.ts` does.
 * `AutomationTriggersService`/`EventStoreService`/`ProjectionRunner`/
 * `MockProvider` have no such transitive dependency and no pending signature
 * change, so they are imported normally (statically). `CommandsService` is
 * constructed via the SAME lightweight "5-dep, cast to a narrower local
 * contract" trick `trigger-scheduler.service.integration.test.ts` uses --
 * `TriggerSuggestionsService.runAnalysis` only ever calls
 * `commandsService.listProposals` (never `parse`/`decide`/anything touching
 * `objectsService`/`relationsService`/`workspaceMembershipService`), so those
 * three trailing constructor args are safely omitted.
 *
 * DESIGN judgment calls pinned by this file (not spelled out verbatim by the
 * ADR excerpt -- implementer must match precisely):
 *   - `TriggerSuggestionsService`'s constructor is `(db, eventStore,
 *     projectionRunner, aiUsageService, aiProvider, automationTriggersService,
 *     commandsService)` -- mirrors `AutomationTriggersService`'s own
 *     constructor-injection style, with the two extra collaborators
 *     `runAnalysis`/`decide` need.
 *   - `list(workspaceId, callerRole): Promise<TriggerTemplateSuggestionSummary[]>`
 *     -- a flat array, mirroring `AutomationTriggersService.list`'s own
 *     unwrapped-array return shape (not `{ suggestions: [...] }` -- that
 *     envelope belongs to the HTTP layer, per `AutomationTriggersController`'s
 *     own `{ triggers }` wrapping happening at the controller, not the
 *     service).
 *   - `runAnalysis(workspaceId, actor, callerRole):
 *     Promise<TriggerTemplateSuggestionSummary[]>` -- returns only the
 *     candidates actually persisted this run (post dry-run-filter, post
 *     dedup), in the SAME order `suggestTriggerTemplates` produced them.
 *   - `decide(workspaceId, actor, callerRole, suggestionId, decision):
 *     Promise<TriggerTemplateSuggestionSummary>` -- returns the single
 *     updated row.
 *   - `TriggerTemplateSuggestionSummary` is a field-for-field copy of the
 *     `trigger_template_suggestions` row shape (mirrors
 *     `CommandProposalSummary`'s own "direct copy, no transformation" doc
 *     comment).
 *   - The event-sourced stream type is `'trigger-template-suggestion'`
 *     (singular, matches the ADR's own prose) and the fixed actor recorded on
 *     every `TriggerTemplateSuggested` event is
 *     `TRIGGER_SUGGESTION_ACTOR = { type: 'agent', id: 'trigger-suggestion-engine' }`
 *     (ADR-0034 §e) -- NEVER used as the actor on the `automation_triggers`
 *     row an approval produces (ADR-0034 §g, pinned by test 7 below).
 * ============================================================================
 */

const TRIGGER_SUGGESTION_ACTOR = { type: 'agent', id: 'trigger-suggestion-engine' } as const;
const SUGGESTION_STREAM_TYPE = 'trigger-template-suggestion';

const TOKEN_QUOTA_PER_WORKSPACE = 10;
const COST_BUDGET_USD_PER_WORKSPACE = 10;

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TriggerTemplateSuggestionSummary {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'scheduled' | 'condition';
  spec: TriggerSpec;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  createdTriggerId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
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

interface CommandProposalSummaryContract {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: unknown;
  decisions: unknown;
  createdAt: Date;
  decidedAt: Date | null;
}

interface CommandsServiceContract {
  listProposals(
    workspaceId: string,
    callerRole: MembershipRole,
    filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
  ): Promise<{ proposals: CommandProposalSummaryContract[]; nextCursor?: string }>;
}

type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageServiceContract,
  aiProvider: AIProvider,
) => CommandsServiceContract;

interface TriggerSuggestionsServiceLike {
  list(
    workspaceId: string,
    callerRole: MembershipRole,
  ): Promise<TriggerTemplateSuggestionSummary[]>;
  runAnalysis(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<TriggerTemplateSuggestionSummary[]>;
  decide(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    suggestionId: string,
    decision: 'approve' | 'reject',
  ): Promise<TriggerTemplateSuggestionSummary>;
}

type TriggerSuggestionsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageServiceContract,
  aiProvider: AIProvider,
  automationTriggersService: AutomationTriggersService,
  commandsService: CommandsServiceContract,
) => TriggerSuggestionsServiceLike;

type TriggerTemplateSuggestionProjectionConstructor = new () => Projection;

interface CandidateSpec {
  name: string;
  rationale: string;
  spec: Record<string, unknown>;
}

function scheduledSpec(
  intervalMinutes: number,
  title = 'Do the suggested thing',
): Record<string, unknown> {
  return { kind: 'scheduled', intervalMinutes, actionTemplate: { title } };
}

function conditionSpec(
  overrides?: Partial<{ objectType: string; fieldKey: string; pattern: string; flags: string }>,
): Record<string, unknown> {
  return {
    kind: 'condition',
    objectType: overrides?.objectType ?? 'task',
    fieldKey: overrides?.fieldKey ?? 'status',
    pattern: overrides?.pattern ?? 'urgent',
    flags: overrides?.flags ?? '',
    actionTemplate: { title: 'Flag as urgent' },
  };
}

/** Never expected to be invoked -- a tripwire for RBAC tests where the caller must be rejected BEFORE any AI call happens. */
function tripwireProvider(): AIProvider {
  return new MockProvider(() => {
    throw new Error(
      'Test bug (or implementer regression): the AI provider must never be invoked for a rejected/cooldown-blocked/quota-blocked runAnalysis call',
    );
  });
}

/** Returns a scripted `{"suggestions": [...]}` envelope, repeating the same response forever (no retry-then-different-response scenario needed by this file). */
function scriptedProvider(candidates: CandidateSpec[]): AIProvider {
  const text = JSON.stringify({ suggestions: candidates });
  return new MockProvider((): AICompletionResult => ({
    text,
    usage: { inputTokens: 2, outputTokens: 1 },
  }));
}

describe('TriggerSuggestionsService (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let automationTriggersService: AutomationTriggersService;
  let commandsService: CommandsServiceContract;
  let TriggerSuggestionsService: TriggerSuggestionsServiceConstructor;
  let TriggerTemplateSuggestionProjection: TriggerTemplateSuggestionProjectionConstructor;
  let sharedAiUsageService: AIUsageServiceContract;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://trigger-suggestions-test-placeholder:6379';
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = String(TOKEN_QUOTA_PER_WORKSPACE);
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = String(COST_BUDGET_USD_PER_WORKSPACE);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // `AutomationTriggersService` is imported dynamically (not statically at
    // the top of this file) because it transitively imports
    // `../db/db.module.js`, which eagerly reads `env.databaseUrl` at module
    // load time -- a static import would evaluate that module (and hard-fail
    // on the missing `DATABASE_URL`) before this `beforeAll` ever sets it.
    // Mirrors the same reasoning already applied to `aiUsageModule`/
    // `commandsModule` below.
    const automationTriggersModule: unknown =
      await import('../automation/automation-triggers.service.js');
    const AutomationTriggersServiceCtor = (
      automationTriggersModule as {
        AutomationTriggersService: new (
          db: Database,
          eventStore: EventStoreService,
          projectionRunner: ProjectionRunner,
        ) => AutomationTriggersService;
      }
    ).AutomationTriggersService;
    automationTriggersService = new AutomationTriggersServiceCtor(db, eventStore, projectionRunner);

    const aiUsageModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageModule as { AIUsageService: AIUsageServiceConstructor })
      .AIUsageService;
    const aiUsageService = new AIUsageServiceCtor(db, eventStore, projectionRunner);

    const commandsModule: unknown = await import('../commands/commands.service.js');
    const CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;
    commandsService = new CommandsServiceCtor(
      db,
      eventStore,
      projectionRunner,
      aiUsageService,
      tripwireProvider(),
    );

    const serviceModule = (await import('./trigger-suggestions.service.js')) as unknown as {
      TriggerSuggestionsService: TriggerSuggestionsServiceConstructor;
    };
    TriggerSuggestionsService = serviceModule.TriggerSuggestionsService;

    const projectionModule = (await import('./trigger-suggestions.projection.js')) as unknown as {
      TriggerTemplateSuggestionProjection: TriggerTemplateSuggestionProjectionConstructor;
    };
    TriggerTemplateSuggestionProjection = projectionModule.TriggerTemplateSuggestionProjection;

    // Stash for helpers below that need a fresh `AIUsageService` per test
    // (the real one, not a re-import) via closure.
    sharedAiUsageService = aiUsageService;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  function buildService(aiProvider: AIProvider): TriggerSuggestionsServiceLike {
    return new TriggerSuggestionsService(
      db,
      eventStore,
      projectionRunner,
      sharedAiUsageService,
      aiProvider,
      automationTriggersService,
      commandsService,
    );
  }

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `trigger-suggestions-test-workspace-${String(workspaceCounter)}`,
        slug: `trigger-suggestions-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  function fakeActor(): Actor {
    return { type: 'user', id: randomUUID() };
  }

  /**
   * Appends a `TriggerTemplateSuggested` event directly (bypassing
   * `runAnalysis`'s own dry-run filter entirely) and projects it -- used to
   * set up `decide()`-focused fixtures (cross-workspace, defense-in-depth,
   * already-decided) without depending on the AI-orchestration path at all.
   */
  async function seedPendingSuggestion(params: {
    workspaceId: string;
    name?: string;
    kind: 'scheduled' | 'condition';
    spec: Record<string, unknown>;
    rationale?: string;
  }): Promise<{ suggestionId: string; streamId: string }> {
    const suggestionId = ulid();
    const streamId = randomUUID();

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: SUGGESTION_STREAM_TYPE,
      workspaceId: params.workspaceId,
      type: 'TriggerTemplateSuggested',
      payload: {
        suggestionId,
        workspaceId: params.workspaceId,
        name: params.name ?? `seeded-suggestion-${suggestionId}`,
        kind: params.kind,
        spec: params.spec,
        rationale: params.rationale ?? 'Seeded directly for a decide()-focused test fixture.',
      },
      actor: TRIGGER_SUGGESTION_ACTOR,
      occurredAt: new Date(),
    };

    await eventStore.append(streamId, 0, [event]);
    await projectionRunner.catchUp(new TriggerTemplateSuggestionProjection());

    return { suggestionId, streamId };
  }

  async function rawSuggestionRow(
    suggestionId: string,
  ): Promise<typeof triggerTemplateSuggestions.$inferSelect | undefined> {
    const [row] = await db
      .select()
      .from(triggerTemplateSuggestions)
      .where(eq(triggerTemplateSuggestions.id, suggestionId));
    return row;
  }

  async function rawSuggestionRows(
    workspaceId: string,
  ): Promise<(typeof triggerTemplateSuggestions.$inferSelect)[]> {
    return db
      .select()
      .from(triggerTemplateSuggestions)
      .where(eq(triggerTemplateSuggestions.workspaceId, workspaceId));
  }

  async function rawTriggerRows(
    workspaceId: string,
  ): Promise<(typeof automationTriggers.$inferSelect)[]> {
    return db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.workspaceId, workspaceId));
  }

  async function rawAnalysisState(
    workspaceId: string,
  ): Promise<typeof triggerSuggestionAnalysisState.$inferSelect | undefined> {
    const [row] = await db
      .select()
      .from(triggerSuggestionAnalysisState)
      .where(eq(triggerSuggestionAnalysisState.workspaceId, workspaceId));
    return row;
  }

  async function seedAnalysisState(workspaceId: string, lastRunAt: Date): Promise<void> {
    await db
      .insert(triggerSuggestionAnalysisState)
      .values({ workspaceId, lastRunAt })
      .onConflictDoUpdate({
        target: triggerSuggestionAnalysisState.workspaceId,
        set: { lastRunAt },
      });
  }

  async function seedQuotaExceeded(workspaceId: string): Promise<void> {
    await db.insert(aiUsageRecords).values({
      id: randomUUID(),
      workspaceId,
      inputTokens: TOKEN_QUOTA_PER_WORKSPACE * 10,
      outputTokens: 0,
      model: 'test-model',
      costUsd: '0',
      createdAt: new Date(),
    });
  }

  // -----------------------------------------------------------------------
  // 1. RBAC (ADR-0034 Karar a)
  // -----------------------------------------------------------------------

  it('1a. Karar (a): list() succeeds for a "member" caller, returning an array', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(tripwireProvider());

    const result = await service.list(workspaceId, 'member');
    expect(Array.isArray(result)).toBe(true);
  });

  it('1b. Karar (a): list() throws ForbiddenError for a "guest" caller (below member)', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(tripwireProvider());

    await expect(service.list(workspaceId, 'guest')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('1c. Karar (a): runAnalysis() throws ForbiddenError for a "member" caller (not admin), and never invokes the AI provider', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(tripwireProvider());

    await expect(service.runAnalysis(workspaceId, fakeActor(), 'member')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('1d. Karar (a): runAnalysis() succeeds for an "admin" caller', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(scriptedProvider([]));

    await expect(service.runAnalysis(workspaceId, fakeActor(), 'admin')).resolves.toEqual([]);
  });

  it('1e. Karar (a): decide() throws ForbiddenError for a "member" caller (not admin)', async () => {
    const workspaceId = await createWorkspace();
    const { suggestionId } = await seedPendingSuggestion({
      workspaceId,
      kind: 'scheduled',
      spec: scheduledSpec(15),
    });
    const service = buildService(tripwireProvider());

    await expect(
      service.decide(workspaceId, fakeActor(), 'member', suggestionId, 'approve'),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const row = await rawSuggestionRow(suggestionId);
    expect(row?.status).toBe('pending');
  });

  // -----------------------------------------------------------------------
  // 2. Cross-workspace isolation
  // -----------------------------------------------------------------------

  it('2a. decide() for a real suggestionId belonging to a DIFFERENT workspace is indistinguishable from not-found (NotFoundError), mirroring commands.service.ts decide()', async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const { suggestionId } = await seedPendingSuggestion({
      workspaceId: workspaceA,
      kind: 'scheduled',
      spec: scheduledSpec(15),
    });
    const service = buildService(tripwireProvider());

    await expect(
      service.decide(workspaceB, fakeActor(), 'admin', suggestionId, 'approve'),
    ).rejects.toBeInstanceOf(NotFoundError);

    const row = await rawSuggestionRow(suggestionId);
    expect(row?.status).toBe('pending');
  });

  it("2b. list() never leaks another workspace's suggestions", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    await seedPendingSuggestion({
      workspaceId: workspaceA,
      name: 'Belongs only to workspace A',
      kind: 'scheduled',
      spec: scheduledSpec(15),
    });
    const service = buildService(tripwireProvider());

    const resultB = await service.list(workspaceB, 'member');
    expect(resultB.some((s) => s.name === 'Belongs only to workspace A')).toBe(false);

    const resultA = await service.list(workspaceA, 'member');
    expect(resultA.some((s) => s.name === 'Belongs only to workspace A')).toBe(true);
  });

  it('2c. decide() on a nonexistent suggestionId (never existed in any workspace) throws NotFoundError', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(tripwireProvider());

    await expect(
      service.decide(workspaceId, fakeActor(), 'admin', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'approve'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // -----------------------------------------------------------------------
  // 3. Cooldown (ADR-0034 Karar b)
  // -----------------------------------------------------------------------

  it('3a. Karar (b): a second runAnalysis() call on the SAME workspace within 15 minutes of a successful first call throws ConflictError, and lastRunAt is NOT advanced by the rejected call', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(scriptedProvider([]));

    await service.runAnalysis(workspaceId, fakeActor(), 'admin');
    const stateAfterFirst = await rawAnalysisState(workspaceId);
    expect(stateAfterFirst).toBeDefined();
    const lastRunAtAfterFirst = stateAfterFirst?.lastRunAt;

    const secondService = buildService(tripwireProvider());
    await expect(
      secondService.runAnalysis(workspaceId, fakeActor(), 'admin'),
    ).rejects.toBeInstanceOf(ConflictError);

    const stateAfterSecond = await rawAnalysisState(workspaceId);
    expect(stateAfterSecond?.lastRunAt.getTime()).toBe(lastRunAtAfterFirst?.getTime());
  });

  it('3b. Karar (b): a workspace whose lastRunAt is seeded MORE than 15 minutes in the past succeeds', async () => {
    const workspaceId = await createWorkspace();
    await seedAnalysisState(workspaceId, new Date(Date.now() - 20 * 60 * 1000));
    const service = buildService(scriptedProvider([]));

    await expect(service.runAnalysis(workspaceId, fakeActor(), 'admin')).resolves.toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 4. Dry-run defensive filter (ADR-0034 Karar f, layer 1)
  // -----------------------------------------------------------------------

  it("4a. Karar (f) layer 1: a candidate whose spec passes JSON-shape validation but fails createTrigger's real business-rule validation (intervalMinutes: 0) is silently dropped -- no TriggerTemplateSuggested event, no persisted row, runAnalysis still succeeds returning an empty array", async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(
      scriptedProvider([{ name: 'Broken interval', rationale: 'test', spec: scheduledSpec(0) }]),
    );

    const created = await service.runAnalysis(workspaceId, fakeActor(), 'admin');
    expect(created).toEqual([]);

    const rows = await rawSuggestionRows(workspaceId);
    expect(rows).toHaveLength(0);
  });

  it('4b. Karar (f) layer 1: with ONE unsafe candidate and ONE safe candidate in the same AI response, only the safe one is persisted (the whole call still succeeds)', async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(
      scriptedProvider([
        { name: 'Broken interval', rationale: 'test', spec: scheduledSpec(0) },
        { name: 'Safe scheduled candidate', rationale: 'test', spec: scheduledSpec(30) },
      ]),
    );

    const created = await service.runAnalysis(workspaceId, fakeActor(), 'admin');
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe('Safe scheduled candidate');

    const rows = await rawSuggestionRows(workspaceId);
    expect(rows).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // 5. Dedup (ADR-0034 Karar h)
  // -----------------------------------------------------------------------

  it('5a. Karar (h): a candidate whose (kind, spec) exactly matches an EXISTING pending suggestion is skipped -- not persisted a second time', async () => {
    const workspaceId = await createWorkspace();
    const spec = conditionSpec({ pattern: 'blocked' });
    await seedPendingSuggestion({ workspaceId, kind: 'condition', spec });

    const service = buildService(
      scriptedProvider([{ name: 'Duplicate candidate', rationale: 'test', spec }]),
    );

    const created = await service.runAnalysis(workspaceId, fakeActor(), 'admin');
    expect(created).toEqual([]);

    const rows = await rawSuggestionRows(workspaceId);
    expect(rows).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // 6. Max 5 per run
  // -----------------------------------------------------------------------

  it('6a. runAnalysis never persists more than 5 rows, even with exactly 5 valid, non-duplicate candidates', async () => {
    const workspaceId = await createWorkspace();
    const candidates: CandidateSpec[] = Array.from({ length: 5 }, (_, index) => ({
      name: `Candidate ${String(index)}`,
      rationale: 'test',
      spec: conditionSpec({ fieldKey: `field-${String(index)}` }),
    }));
    const service = buildService(scriptedProvider(candidates));

    const created = await service.runAnalysis(workspaceId, fakeActor(), 'admin');
    expect(created).toHaveLength(5);

    const rows = await rawSuggestionRows(workspaceId);
    expect(rows).toHaveLength(5);
  });

  // -----------------------------------------------------------------------
  // 7. decide() approve path (Karar f layer 2 / g)
  // -----------------------------------------------------------------------

  it('7a. Karar (f) layer 2 / (g): approving a pending suggestion calls the REAL AutomationTriggersService.create -- a real automation_triggers row appears with matching name/spec, actor is the REAL approving admin (never TRIGGER_SUGGESTION_ACTOR), and the suggestion becomes approved with createdTriggerId + decidedAt set', async () => {
    const workspaceId = await createWorkspace();
    const approvingAdmin: Actor = { type: 'user', id: randomUUID() };
    const { suggestionId } = await seedPendingSuggestion({
      workspaceId,
      name: 'Approve me',
      kind: 'scheduled',
      spec: scheduledSpec(45),
    });
    const service = buildService(tripwireProvider());

    const updated = await service.decide(
      workspaceId,
      approvingAdmin,
      'admin',
      suggestionId,
      'approve',
    );

    expect(updated.status).toBe('approved');
    expect(updated.createdTriggerId).toBeDefined();
    expect(updated.decidedAt).not.toBeNull();

    const triggerRows = await rawTriggerRows(workspaceId);
    expect(triggerRows).toHaveLength(1);
    const [triggerRow] = triggerRows;
    expect(triggerRow?.id).toBe(updated.createdTriggerId);
    expect(triggerRow?.name).toBe('Approve me');
    expect(triggerRow?.spec).toMatchObject({ kind: 'scheduled', intervalMinutes: 45 });

    // Actor provenance (ADR-0034 §g): read the REAL TriggerCreated event's own
    // recorded actor directly off the event log -- never trust a value that
    // could have been silently defaulted.
    const events = await eventStore.readStream(triggerRow?.streamId ?? '');
    const createdEvent = events.find((event) => event.type === 'TriggerCreated');
    expect(createdEvent?.actor).toEqual(approvingAdmin);
    expect(createdEvent?.actor).not.toEqual(TRIGGER_SUGGESTION_ACTOR);
  });

  // -----------------------------------------------------------------------
  // 8. decide() reject path
  // -----------------------------------------------------------------------

  it('8a. rejecting a pending suggestion sets status "rejected" + decidedAt, and creates NO automation_triggers row at all', async () => {
    const workspaceId = await createWorkspace();
    const { suggestionId } = await seedPendingSuggestion({
      workspaceId,
      kind: 'scheduled',
      spec: scheduledSpec(60),
    });
    const service = buildService(tripwireProvider());

    const updated = await service.decide(workspaceId, fakeActor(), 'admin', suggestionId, 'reject');

    expect(updated.status).toBe('rejected');
    expect(updated.decidedAt).not.toBeNull();
    expect(updated.createdTriggerId).toBeNull();

    const triggerRows = await rawTriggerRows(workspaceId);
    expect(triggerRows).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 9. decide() defense-in-depth failure (Karar f layer 2)
  // -----------------------------------------------------------------------

  it('9a. Karar (f) layer 2: approving a suggestion whose stored spec would fail AutomationTriggersService.create\'s real validation throws, the suggestion remains "pending" (NOT approved), and no automation_triggers row is created', async () => {
    const workspaceId = await createWorkspace();
    // Bypasses runAnalysis's own layer-1 dry-run filter entirely (simulates a
    // row that somehow got persisted with an invalid spec -- e.g. a manual DB
    // edit, or a future producer bug), to isolate layer 2 in this test.
    const { suggestionId } = await seedPendingSuggestion({
      workspaceId,
      kind: 'scheduled',
      spec: scheduledSpec(0),
    });
    const service = buildService(tripwireProvider());

    await expect(
      service.decide(workspaceId, fakeActor(), 'admin', suggestionId, 'approve'),
    ).rejects.toThrow();

    const row = await rawSuggestionRow(suggestionId);
    expect(row?.status).toBe('pending');
    expect(row?.createdTriggerId).toBeNull();

    const triggerRows = await rawTriggerRows(workspaceId);
    expect(triggerRows).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 10. decide() on an already-decided suggestion
  // -----------------------------------------------------------------------

  it('10a. a second decide() call on the same (already-decided) suggestionId throws ConflictError, mirroring commands.service.ts decide()\'s exact "already decided" guard', async () => {
    const workspaceId = await createWorkspace();
    const { suggestionId } = await seedPendingSuggestion({
      workspaceId,
      kind: 'scheduled',
      spec: scheduledSpec(15),
    });
    const service = buildService(tripwireProvider());

    await service.decide(workspaceId, fakeActor(), 'admin', suggestionId, 'reject');

    await expect(
      service.decide(workspaceId, fakeActor(), 'admin', suggestionId, 'approve'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  // -----------------------------------------------------------------------
  // 11. AI quota/lock integration
  // -----------------------------------------------------------------------

  it('11a. an exceeded AI token quota propagates QuotaExceededError out of runAnalysis, persists NO suggestion, and does NOT advance lastRunAt', async () => {
    const workspaceId = await createWorkspace();
    await seedQuotaExceeded(workspaceId);
    const service = buildService(tripwireProvider());

    await expect(service.runAnalysis(workspaceId, fakeActor(), 'admin')).rejects.toBeInstanceOf(
      QuotaExceededError,
    );

    const rows = await rawSuggestionRows(workspaceId);
    expect(rows).toHaveLength(0);
    const state = await rawAnalysisState(workspaceId);
    expect(state).toBeUndefined();
  });

  it('11b. the cooldown check runs BEFORE the quota check inside the workspace AI lock -- a workspace that is BOTH cooldown-blocked AND quota-exceeded throws ConflictError (cooldown), never QuotaExceededError', async () => {
    const workspaceId = await createWorkspace();
    await seedQuotaExceeded(workspaceId);
    await seedAnalysisState(workspaceId, new Date());
    const service = buildService(tripwireProvider());

    await expect(service.runAnalysis(workspaceId, fakeActor(), 'admin')).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  // -----------------------------------------------------------------------
  // 12. Suggestion id is a fresh ULID, never the AI orchestrator's own UUID
  // -----------------------------------------------------------------------

  it("12a. the persisted suggestion's own id is a valid ULID (26 chars, Crockford base32) minted by runAnalysis itself -- NEVER the raw UUID suggestTriggerTemplates's TriggerTemplateCandidate.suggestionId produces internally", async () => {
    const workspaceId = await createWorkspace();
    const service = buildService(
      scriptedProvider([{ name: 'ULID pin check', rationale: 'test', spec: scheduledSpec(20) }]),
    );

    const created = await service.runAnalysis(workspaceId, fakeActor(), 'admin');
    expect(created).toHaveLength(1);
    const [suggestion] = created;

    expect(suggestion?.id).toBeDefined();
    expect(suggestion?.id.length).toBe(26);
    expect(ULID_REGEX.test(suggestion?.id ?? '')).toBe(true);
    expect(UUID_REGEX.test(suggestion?.id ?? '')).toBe(false);

    const row = await rawSuggestionRow(suggestion?.id ?? '');
    expect(row).toBeDefined();
    expect(ULID_REGEX.test(row?.id ?? '')).toBe(true);
  });
});
