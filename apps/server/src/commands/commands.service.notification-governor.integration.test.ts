import crypto, { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';

import { AgentActionRecordsService } from '../agent-runtime/agent-action-records.service.js';
import { AgentPermissionManifestsService } from '../agent-runtime/agent-permission-manifests.service.js';
import { AutonomyTierSettingsService } from '../agent-runtime/autonomy-tier-settings.service.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { CommentsService } from '../comments/object-comments.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { AIUsageService } from '../ai/ai-usage.service.js';
import type { Database } from '../db/client.js';
import type { ObjectsService } from '../objects/objects.service.js';
import type { RelationsService } from '../relations/relations.service.js';
import type { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T13 PR2 (RED step), ADR-0047 Karar (h) — wiring a NEW 13th constructor
 * dependency, `AgentNotificationGovernorService`, into `CommandsService`'s
 * `notifyAutonomousAction` (`./commands.service.ts:660-680` as of this
 * commit): the existing `this.commentsService.create(...)` call must move
 * INSIDE a `deliver` callback passed to `this.notificationGovernor.
 * guardAndDeliver(workspaceId, action.type, sourceObjectId, deliver)`, with
 * the pre-existing try/catch now wrapping that `guardAndDeliver` call
 * instead of the bare `commentsService.create` call. This file does NOT
 * re-test the governor's own budget/quiet-hours logic (that is
 * `../agent-runtime/agent-notification-governor.service.integration.test.ts`'s
 * job) -- it ONLY tests `CommandsService`'s WIRING to it, via a locally
 * defined FAKE governor (a plain object satisfying the widened
 * constructor's structural type -- no real Postgres-backed governor
 * instance needed for these scenarios).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `CommandsService`'s real constructor still has
 * only 12 parameters and `notifyAutonomousAction` still calls
 * `this.commentsService.create(...)` UNCONDITIONALLY (never through any
 * injected governor). Passing a 13th constructor argument to today's 12-arg
 * constructor is a harmless, non-throwing JS call (mirrors
 * `commands.service.autonomy-dial.integration.test.ts`'s own documented
 * precedent for exactly this situation) -- so this file's RED failures come
 * from RUNTIME assertions, not from construction:
 *   - Scenarios 3/4 below (the actual wiring tests) fail TODAY because
 *     `commentsService.create` is called directly regardless of what the
 *     fake governor's `guardAndDeliver` does (today's code never calls the
 *     fake governor at all) -- these are the file's REAL red signal.
 *   - Scenarios 1/2 (the "unchanged behavior" regression guards) may
 *     ALREADY PASS today, since they assert invariants
 *     (`sourceObjectId===undefined` early return; a governor/notification
 *     failure never affecting the primary action) that ADR-0047 Karar h
 *     requires to REMAIN true post-implementation, not properties that only
 *     exist once the governor is wired in. This is expected, not a bug in
 *     this test file -- see each `it`'s own comment.
 *
 * Reuses `./commands.service.autonomy-dial.integration.test.ts`'s exact
 * FULL-`AppModule` harness (real Postgres 16 + Redis 7 via Testcontainers,
 * `Test.createTestingModule({imports:[AppModule]})`, real collaborator
 * services pulled out of that container via `app.get(...)`, `CommandsService`
 * itself manually `new`'d with those real instances PLUS a locally
 * constructed fake governor) -- built ONCE in `beforeAll`; each `it` below
 * builds its OWN lightweight `CommandsService` wrapper (cheap, no
 * Testcontainers cost) via `createService(fakeGovernor)` so every scenario
 * gets a governor stub with different behavior.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `CommandsService`'s widened constructor: today's 12 args PLUS a NEW 13th
 * (and final) `notificationGovernor: AgentNotificationGovernorService`.
 * `notifyAutonomousAction`'s new body (ADR-0047 Karar h, verbatim):
 *   ```
 *   if (sourceObjectId === undefined) return; // UNCHANGED, governor never touched
 *   try {
 *     await this.notificationGovernor.guardAndDeliver(
 *       workspaceId, action.type, sourceObjectId,
 *       async () => {
 *         const comment = await this.commentsService.create(workspaceId, AUTONOMY_DIAL_ACTOR, 'member', {
 *           objectId: sourceObjectId, body: `...${action.intent}`,
 *         });
 *         return { commentId: comment.id };
 *       },
 *     );
 *   } catch (error) { /* logged, swallowed, same as today *\/ }
 *   ```
 * ============================================================================
 */

interface ProposedActionContract {
  actionId: string;
  type: 'createTask';
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}

interface DecideActionResult {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
}

interface CommandsServiceParseResult {
  proposalId: string;
  actions: ProposedActionContract[];
  parseError: boolean;
  message?: string;
  autonomousResults?: DecideActionResult[];
}

/** A minimal, structural fake -- ONLY `guardAndDeliver` is ever called by
 * `notifyAutonomousAction`'s new wiring, so this is the entire surface this
 * file's fakes need to satisfy. Declared locally rather than importing the
 * real (not-yet-existing) `AgentNotificationGovernorService` class, same
 * "does not exist yet" convention as every sibling RED-step file in this
 * repo. */
interface FakeNotificationGovernor {
  guardAndDeliver: (
    workspaceId: string,
    actionType: string,
    sourceObjectId: string,
    deliver: () => Promise<{ commentId: string }>,
  ) => Promise<void>;
}

interface CommandsServiceContract {
  proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string | undefined,
    actions: ProposedActionContract[],
  ): Promise<CommandsServiceParseResult>;
}

/** This PR's own pinned constructor shape: today's 12 args (already merged
 * through F3-T5 PR2 / F3-T13 PR1) PLUS a NEW 13th (and final)
 * `notificationGovernor`. */
type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageService,
  aiProvider: AIProvider,
  objectsService: ObjectsService,
  relationsService: RelationsService,
  workspaceMembershipService: WorkspaceMembershipService,
  agentPermissionManifestsService: AgentPermissionManifestsService,
  agentActionRecordsService: AgentActionRecordsService,
  autonomyTierSettingsService: AutonomyTierSettingsService,
  commentsService: CommentsService,
  notificationGovernor: FakeNotificationGovernor,
) => CommandsServiceContract;

interface AgentActionRecordContract {
  id: string;
  workspaceId: string;
  provenance: 'decided' | 'autonomous';
  actor: Actor;
  actionType: string;
  intent: string;
  causationEventId: string | null;
}

/** Always calls `deliver()` and returns -- the "governor found nothing to
 * suppress" happy path a real, unconfigured-recipient governor would take
 * (mirrors the REAL governor's own fail-open contract, but this file does
 * not need the real class to express it). */
function passthroughGovernor(): FakeNotificationGovernor {
  return {
    guardAndDeliver: (_workspaceId, _actionType, _sourceObjectId, deliver) =>
      deliver().then(() => undefined),
  };
}

/** Never calls `deliver()` -- simulates a real governor's quiet-hours/budget
 * suppression branch (ADR-0047 Karar h, steps 3/4). */
function suppressingGovernor(onCall: () => void): FakeNotificationGovernor {
  return {
    guardAndDeliver: () => {
      onCall();
      return Promise.resolve();
    },
  };
}

/** Always REJECTS, before ever calling `deliver()` -- simulates a governor-
 * internal failure (e.g. a DB write error recording the outcome) to prove
 * the primary action/ledger write is unaffected (ADR-0047 Karar h's
 * preserved best-effort try/catch). */
function throwingGovernor(): FakeNotificationGovernor {
  return {
    guardAndDeliver: () => Promise.reject(new Error('simulated governor failure')),
  };
}

describe('CommandsService notification-governor wiring (F3-T13 PR2, real Postgres + real Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;
  let eventStore: EventStoreService;
  let objectsService: ObjectsService;
  let relationsService: RelationsService;
  let workspaceMembershipService: WorkspaceMembershipService;
  let aiUsageService: AIUsageService;
  let aiProvider: AIProvider;
  let agentPermissionManifestsService: AgentPermissionManifestsService;
  let agentActionRecordsService: AgentActionRecordsService;
  let autonomyTierSettingsService: AutonomyTierSettingsService;
  let commentsService: CommentsService;
  let projectionRunner: ProjectionRunner;
  let CommandsServiceCtor: CommandsServiceConstructor;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get<Database>(DATABASE_CONNECTION);
    eventStore = app.get(EventStoreService);
    projectionRunner = app.get(ProjectionRunner);
    aiProvider = app.get<AIProvider>(AI_PROVIDER);

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (objectsServiceModule as { ObjectsService: Type<ObjectsService> })
      .ObjectsService;
    objectsService = app.get<ObjectsService>(ObjectsServiceCtor);

    const relationsServiceModule: unknown = await import('../relations/relations.service.js');
    const RelationsServiceCtor = (
      relationsServiceModule as { RelationsService: Type<RelationsService> }
    ).RelationsService;
    relationsService = app.get<RelationsService>(RelationsServiceCtor);

    const workspaceMembershipServiceModule: unknown =
      await import('../workspaces/workspace-membership.service.js');
    const WorkspaceMembershipServiceCtor = (
      workspaceMembershipServiceModule as {
        WorkspaceMembershipService: Type<WorkspaceMembershipService>;
      }
    ).WorkspaceMembershipService;
    workspaceMembershipService = app.get<WorkspaceMembershipService>(
      WorkspaceMembershipServiceCtor,
    );

    const aiUsageServiceModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageServiceModule as { AIUsageService: Type<AIUsageService> })
      .AIUsageService;
    aiUsageService = app.get<AIUsageService>(AIUsageServiceCtor);

    agentPermissionManifestsService = app.get(AgentPermissionManifestsService);
    agentActionRecordsService = app.get(AgentActionRecordsService);
    autonomyTierSettingsService = app.get(AutonomyTierSettingsService);
    commentsService = app.get(CommentsService);

    const commandsModule: unknown = await import('./commands.service.js');
    CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createService(notificationGovernor: FakeNotificationGovernor): CommandsServiceContract {
    return new CommandsServiceCtor(
      db,
      eventStore,
      projectionRunner,
      aiUsageService,
      aiProvider,
      objectsService,
      relationsService,
      workspaceMembershipService,
      agentPermissionManifestsService,
      agentActionRecordsService,
      autonomyTierSettingsService,
      commentsService,
      notificationGovernor,
    );
  }

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

  function createTaskAction(title: string, intent: string): ProposedActionContract {
    return {
      actionId: randomUUID(),
      type: 'createTask',
      intent,
      rationale: 'Notification-governor wiring test fixture',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: { title },
    };
  }

  async function setActAndNotify(workspaceId: string): Promise<void> {
    const adminActor: Actor = { type: 'user', id: randomUUID() };
    await autonomyTierSettingsService.set(
      workspaceId,
      'createTask',
      'act_and_notify',
      adminActor,
      'admin',
    );
  }

  async function getLedgerRecords(workspaceId: string): Promise<AgentActionRecordContract[]> {
    return agentActionRecordsService.list(workspaceId, 'member');
  }

  function findRecordByIntent(
    records: AgentActionRecordContract[],
    intent: string,
  ): AgentActionRecordContract | undefined {
    return records.find((record) => record.intent === intent);
  }

  async function countObjectCommentsInWorkspace(workspaceId: string): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      'select count(*)::text as count from object_comments where workspace_id = $1',
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // =========================================================================
  // 1. sourceObjectId === undefined early return -- UNCHANGED regression.
  // =========================================================================

  it('1. sourceObjectId===undefined: notifyAutonomousAction returns early WITHOUT ever calling the governor or creating a comment (ADR-0039 §h behavior, unchanged by this PR)', async () => {
    const workspaceId = await createWorkspace('notif-governor-ac1');
    await setActAndNotify(workspaceId);

    let guardAndDeliverCalls = 0;
    const service = createService(
      suppressingGovernor(() => {
        guardAndDeliverCalls += 1;
      }),
    );

    const triggerId = newObjectId();
    const intent = 'Notif-governor AC1 intent';
    const action = createTaskAction('Notif-governor AC1 task', intent);

    const result = await service.proposeFromTrigger(workspaceId, triggerId, undefined, [action]);

    expect(result.parseError).toBe(false);
    expect(guardAndDeliverCalls).toBe(0);
    expect(await countObjectCommentsInWorkspace(workspaceId)).toBe(0);

    // The action itself still executes -- only the NOTIFICATION step is
    // skipped for a missing sourceObjectId (ADR-0039 §h precedent).
    const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
    expect(record).toBeDefined();
    expect(record?.provenance).toBe('autonomous');
  });

  // =========================================================================
  // 2. Best-effort: a governor failure never affects the primary action.
  // =========================================================================

  it("2. a governor that REJECTS never affects the primary action's execution/ledger write (best-effort regression, ADR-0039 §h's preserved try/catch)", async () => {
    const workspaceId = await createWorkspace('notif-governor-ac2');
    await setActAndNotify(workspaceId);

    const service = createService(throwingGovernor());

    const triggerId = newObjectId();
    const sourceObjectId = newObjectId();
    const intent = 'Notif-governor AC2 intent';
    const action = createTaskAction('Notif-governor AC2 task', intent);

    const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
      action,
    ]);

    expect(result.parseError).toBe(false);
    expect(result.autonomousResults).toEqual([{ actionId: action.actionId, status: 'executed' }]);

    const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
    expect(record).toBeDefined();
    expect(record?.provenance).toBe('autonomous');
  });

  // =========================================================================
  // 3. Wiring: a suppressing governor prevents the comment entirely.
  // =========================================================================

  it('3. WIRING: when guardAndDeliver never calls its deliver callback (simulated suppression), commentsService.create is NEVER called', async () => {
    const workspaceId = await createWorkspace('notif-governor-ac3');
    await setActAndNotify(workspaceId);

    let guardAndDeliverCalls = 0;
    const createSpy = vi.spyOn(commentsService, 'create');
    const service = createService(
      suppressingGovernor(() => {
        guardAndDeliverCalls += 1;
      }),
    );

    const triggerId = newObjectId();
    const sourceObjectId = newObjectId();
    const intent = 'Notif-governor AC3 intent';
    const action = createTaskAction('Notif-governor AC3 task', intent);

    await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [action]);

    expect(guardAndDeliverCalls).toBe(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(await countObjectCommentsInWorkspace(workspaceId)).toBe(0);
  });

  // =========================================================================
  // 4. Wiring: a passthrough governor's deliver() callback IS commentsService.create.
  // =========================================================================

  it('4. WIRING: when guardAndDeliver calls its deliver callback, commentsService.create IS called with the SAME (workspaceId, actor, role, {objectId, body}) shape as before this PR', async () => {
    const workspaceId = await createWorkspace('notif-governor-ac4');
    await setActAndNotify(workspaceId);

    const createSpy = vi.spyOn(commentsService, 'create');
    const service = createService(passthroughGovernor());

    const triggerId = newObjectId();
    const sourceObject = await objectsService.create(
      workspaceId,
      { type: 'user', id: randomUUID() },
      { objectType: 'task', title: 'Notif-governor AC4 source object' },
      'owner',
    );
    const sourceObjectId = sourceObject.id;
    const intent = 'Notif-governor AC4 intent';
    const action = createTaskAction('Notif-governor AC4 task', intent);

    await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [action]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [calledWorkspaceId, , calledRole, calledInput] = createSpy.mock.calls[0] ?? [];
    expect(calledWorkspaceId).toBe(workspaceId);
    expect(calledRole).toBe('member');
    expect(calledInput).toMatchObject({ objectId: sourceObjectId });
    expect((calledInput as { body: string }).body).toContain(intent);
    expect((calledInput as { body: string }).body).toContain('yap-bildir');

    expect(await countObjectCommentsInWorkspace(workspaceId)).toBe(1);
  });
});
