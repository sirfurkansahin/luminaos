import crypto, { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Role } from '@luminaos/core-objects';
import { ForbiddenError } from '@luminaos/shared';
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
 * F3-T5 PR2 (RED step), ADR-0039 — wiring `AutonomyTierSettingsService`
 * (PR1, already merged, `../agent-runtime/autonomy-tier-settings.service.ts`)
 * into `CommandsService`'s 4 "propose" methods, per this task's own
 * description (§1-§8: `AUTONOMY_DIAL_ACTOR`, `dispatchExecute`,
 * `executeAutonomousAction`, `notifyAutonomousAction`, `decideAsSystem`,
 * `routeProposedActions`, `CommandsServiceParseResult.autonomousResults`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NONE of the above exist on `./commands.service.ts`
 * yet -- every `propose*` method still ends by calling the private
 * `recordProposal(...)` directly, with NO tier-resolution step at all. This
 * file's constructor type below already pins the WIDENED 12-arg shape
 * (`agentPermissionManifestsService`/`agentActionRecordsService` -- both
 * already merged -- PLUS a NEW 11th `autonomyTierSettingsService` and a NEW
 * 12th `commentsService`) that `implementer` must produce; passing 2 extra
 * arguments to today's 10-arg constructor is a harmless, non-throwing JS call
 * (mirrors `commands.service.ledger.integration.test.ts`'s own precedent) --
 * the RED failure signal here comes from this file's own RUNTIME assertions
 * (task never created for an `'approve_and_act'`/`'act_and_notify'` tier,
 * `autonomousResults` never present, no `provenance:'autonomous'` ledger
 * record ever written), never from the construction step itself.
 *
 * Reuses `./commands.service.ledger.integration.test.ts`'s exact FULL-
 * `AppModule` harness (real Postgres 16 + Redis 7 via Testcontainers,
 * `Test.createTestingModule({imports:[AppModule]})`, real collaborator
 * services pulled out of that container via `app.get(...)`, `CommandsService`
 * itself manually `new`'d with those real instances) -- booting the full
 * `AppModule` here ALSO means a real `CommandsModule`<->`CommentsModule`
 * circular-import mistake (this PR's own module-wiring risk, needing
 * `forwardRef()` on both sides per this task's own description) fails this
 * file's `beforeAll` immediately and loudly, rather than silently.
 *
 * `AutonomyTierSettingsService`/`CommentsService` are BOTH already-merged,
 * unchanged-shape real classes (PR1 / F3-T3) -- pulled directly via
 * `app.get(...)`, no local widened-contract interface needed for either,
 * unlike `CommandsService` itself.
 *
 * Lightweight fixture workspaces (direct `db.insert(workspaces)`, no HTTP
 * user registration) -- mirrors `./commands.service.propose-from-trigger.integration.test.ts`'s
 * own precedent: none of this file's scenarios need a real registered user or
 * a real `memberships` row (no `assignPeople`/field-permission check is ever
 * actually EXECUTED here -- the one `assignPeople` fixture action in the
 * mixed-tier test deliberately stays pending forever).
 * ============================================================================
 */

/** Mirrors the task description's own fixed shape exactly -- reference
 * equality against this exact literal is an IMPLEMENTATION detail
 * (`CommandsService`'s own internal `AUTONOMY_DIAL_ACTOR` singleton), this
 * file only ever asserts on the resulting ledger record's `actor` VALUE, so a
 * plain structural `toEqual` against this local copy is sufficient. */
const AUTONOMY_DIAL_ACTOR = { type: 'system', id: 'autonomy-dial' } as const;

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

interface DecideActionResult {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
  createdCount?: number;
  totalCount?: number;
  failedAtStep?: number;
  error?: string;
}

/** The `CommandsServiceParseResult` shape `implementer` must produce -- a
 * pure ADDITIVE widening of today's real (narrower) type: `autonomousResults`
 * is OPTIONAL and, per this task's §7, only ever present (never an empty
 * array) when at least one action was routed autonomously. */
interface CommandsServiceParseResult {
  proposalId: string;
  actions: ProposedActionContract[];
  parseError: boolean;
  message?: string;
  autonomousResults?: DecideActionResult[];
}

interface DecisionInput {
  actionId: string;
  decision: 'approved' | 'rejected';
}

/** The public contract `CommandsService` must satisfy once `implementer`
 * lands this PR -- declared locally, same reasoning as every sibling file in
 * this directory (the REAL exported class does not have this shape yet). */
interface CommandsServiceContract {
  proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string | undefined,
    actions: ProposedActionContract[],
  ): Promise<CommandsServiceParseResult>;
  decide(
    workspaceId: string,
    proposalId: string,
    approverActor: Actor,
    callerRole: Role,
    decisions: DecisionInput[],
  ): Promise<{ results: DecideActionResult[] }>;
}

/** This PR's own pinned constructor shape: today's 10 args PLUS a NEW 11th
 * `autonomyTierSettingsService` and a NEW 12th (and final) `commentsService`
 * -- see this file's header for why passing 2 extra args to a constructor
 * that doesn't declare them yet is still a safe, non-throwing JS call. */
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
) => CommandsServiceContract;

interface RawCommandProposalRow {
  id: string;
  stream_id: string;
  workspace_id: string;
  source_object_id: string | null;
  actions: unknown;
  decisions: unknown;
  decided_at: Date | null;
}

interface AgentActionRecordContract {
  id: string;
  workspaceId: string;
  provenance: 'decided' | 'autonomous';
  actor: Actor;
  actionType: string;
  intent: string;
  causationEventId: string | null;
}

interface ObjectCommentContract {
  id: string;
  objectId: string;
  body: string;
}

describe('CommandsService autonomy-dial wiring (F3-T5 PR2, real Postgres + real Redis via Testcontainers)', () => {
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
  let service: CommandsServiceContract;

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
    const projectionRunner = app.get(ProjectionRunner);
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

    // Already merged (F3-T3 PR4 / F3-T4 PR1 / F3-T5 PR1) -- real instances
    // pulled straight out of the real DI container.
    agentPermissionManifestsService = app.get(AgentPermissionManifestsService);
    agentActionRecordsService = app.get(AgentActionRecordsService);
    autonomyTierSettingsService = app.get(AutonomyTierSettingsService);
    commentsService = app.get(CommentsService);

    const commandsModule: unknown = await import('./commands.service.js');
    const CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;
    service = new CommandsServiceCtor(
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
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
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

  function createTaskAction(
    title: string,
    intent = 'Create a follow-up task',
  ): ProposedActionContract {
    return {
      actionId: randomUUID(),
      type: 'createTask',
      intent,
      rationale: 'Autonomy-dial test fixture',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: { title },
    };
  }

  function assignPeopleAction(
    objectId: string,
    fieldKey: string,
    userIds: string[],
    intent = 'Assign people to the object',
  ): ProposedActionContract {
    return {
      actionId: randomUUID(),
      type: 'assignPeople',
      intent,
      rationale: 'Autonomy-dial test fixture -- must stay pending in the mixed-tier scenario',
      resources: [objectId],
      rollbackNote: 'Unassign the people',
      params: { objectId, fieldKey, userIds },
    };
  }

  function reconfigureAction(
    agentIdentifier: string,
    intent = 'Reconfigure agent permissions',
  ): ProposedActionContract {
    return {
      actionId: randomUUID(),
      type: 'reconfigureAgentPermissions',
      intent,
      rationale: 'Autonomy-dial test fixture -- governance floor must keep this pending',
      resources: [agentIdentifier],
      rollbackNote: 'Reverse the grant/revoke if this was a mistake',
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
      'select id, stream_id, workspace_id, source_object_id, actions, decisions, decided_at from command_proposals where id = $1',
      [proposalId],
    );
    return result.rows[0];
  }

  async function findObjectByTitle(workspaceId: string, title: string) {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    return objects.find((object) => object.title === title);
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

  async function listComments(
    workspaceId: string,
    objectId: string,
  ): Promise<ObjectCommentContract[]> {
    return commentsService.list(workspaceId, 'member', objectId);
  }

  async function countObjectCommentsInWorkspace(workspaceId: string): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      'select count(*)::text as count from object_comments where workspace_id = $1',
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // =======================================================================
  // 1. Propose-tier regression: default (unset) autonomy -- behaves exactly
  // as before this PR.
  // =======================================================================

  describe('1. propose-tier regression (no autonomy setting configured -- default "propose")', () => {
    it('lands the action pending in command_proposals, decidedAt null, autonomousResults genuinely absent, and never executes the action', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac1');
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const title = 'Autonomy-dial AC1 task (must stay pending)';
      const action = createTaskAction(title);

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        action,
      ]);

      expect(result.parseError).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, 'autonomousResults')).toBe(false);
      expect(result.autonomousResults).toBeUndefined();

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.decided_at).toBeNull();
      expect(row?.actions).toEqual([action]);

      expect(await findObjectByTitle(workspaceId, title)).toBeUndefined();
    });
  });

  // =======================================================================
  // 2. Approve-and-act tier
  // =======================================================================

  describe('2. a workspace with createTask set to "approve_and_act"', () => {
    it('auto-executes the task, auto-decides the proposal (decidedAt set, real ActionsDecided event), returns autonomousResults, and ledgers provenance "autonomous" with a non-null causationEventId', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac2');
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      await autonomyTierSettingsService.set(
        workspaceId,
        'createTask',
        'approve_and_act',
        adminActor,
        'admin',
      );

      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const title = 'Autonomy-dial AC2 approve-and-act task';
      const intent = 'Autonomy-dial AC2 intent';
      const action = createTaskAction(title, intent);

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        action,
      ]);

      expect(result.parseError).toBe(false);

      const created = await findObjectByTitle(workspaceId, title);
      expect(created).toBeDefined();

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.decided_at).not.toBeNull();

      expect(result.autonomousResults).toEqual([{ actionId: action.actionId, status: 'executed' }]);

      const events = await eventStore.readStream(row?.stream_id ?? '');
      const decidedEvent = events.find((event) => event.type === 'ActionsDecided');
      expect(decidedEvent).toBeDefined();

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.provenance).toBe('autonomous');
      expect(record?.actor).toEqual(AUTONOMY_DIAL_ACTOR);
      expect(record?.actionType).toBe('createTask');
      expect(record?.causationEventId).not.toBeNull();
      expect(record?.causationEventId).toBe(decidedEvent?.id);
    });
  });

  // =======================================================================
  // 3. Act-and-notify tier
  // =======================================================================

  describe('3. a workspace with createTask set to "act_and_notify" (with a real sourceObjectId)', () => {
    it('auto-executes the task WITHOUT ever writing it into command_proposals.actions, ledgers provenance "autonomous" with a null causationEventId, and posts a notification comment on sourceObjectId', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac3');
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      await autonomyTierSettingsService.set(
        workspaceId,
        'createTask',
        'act_and_notify',
        adminActor,
        'admin',
      );

      const sourceObject = await objectsService.create(
        workspaceId,
        adminActor,
        { objectType: 'task', title: 'Autonomy-dial AC3 source object' },
        'owner',
      );

      const triggerId = newObjectId();
      const title = 'Autonomy-dial AC3 act-and-notify task';
      const intent = 'Autonomy-dial AC3 intent';
      const action = createTaskAction(title, intent);

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObject.id, [
        action,
      ]);

      expect(result.parseError).toBe(false);

      const created = await findObjectByTitle(workspaceId, title);
      expect(created).toBeDefined();

      // The invariant: `createTask` action itself never appears in ANY
      // `command_proposals.actions` payload -- `recordProposal` is still
      // called (exactly once per propose-call, always), but with an EMPTY
      // `remaining` array.
      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.actions).toEqual([]);
      expect(row?.decided_at).toBeNull();

      expect(result.autonomousResults).toEqual([{ actionId: action.actionId, status: 'executed' }]);

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.provenance).toBe('autonomous');
      expect(record?.actor).toEqual(AUTONOMY_DIAL_ACTOR);
      expect(record?.causationEventId).toBeNull();

      const comments = await listComments(workspaceId, sourceObject.id);
      const notification = comments.find((comment) => comment.body.includes(intent));
      expect(notification).toBeDefined();
      expect(notification?.body).toContain('yap-bildir');
    });
  });

  // =======================================================================
  // 4. Act-and-notify tier, no sourceObjectId at all
  // =======================================================================

  describe('4. act_and_notify with NO sourceObjectId (e.g. a scheduled trigger fire)', () => {
    it('still auto-executes and ledgers the task, but skips notification entirely (no comment created anywhere) -- not an error', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac4');
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      await autonomyTierSettingsService.set(
        workspaceId,
        'createTask',
        'act_and_notify',
        adminActor,
        'admin',
      );

      const triggerId = newObjectId();
      const title = 'Autonomy-dial AC4 act-and-notify task (no source object)';
      const intent = 'Autonomy-dial AC4 intent';
      const action = createTaskAction(title, intent);

      const result = await service.proposeFromTrigger(workspaceId, triggerId, undefined, [action]);

      expect(result.parseError).toBe(false);

      const created = await findObjectByTitle(workspaceId, title);
      expect(created).toBeDefined();

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.provenance).toBe('autonomous');

      expect(await countObjectCommentsInWorkspace(workspaceId)).toBe(0);
    });
  });

  // =======================================================================
  // 5. Mixed-tier conservative fallback
  // =======================================================================

  describe('5. a batch mixing an "approve_and_act" action with a "propose" action', () => {
    it('auto-decides NEITHER action -- the whole remaining batch stays pending, no autonomousResults, no ledger record for either action yet', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac5');
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      await autonomyTierSettingsService.set(
        workspaceId,
        'createTask',
        'approve_and_act',
        adminActor,
        'admin',
      );
      // assignPeople is left at its default 'propose' tier -- explicit `set`
      // to the same default is harmless and documents the intent.
      await autonomyTierSettingsService.set(
        workspaceId,
        'assignPeople',
        'propose',
        adminActor,
        'admin',
      );

      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const taskTitle = 'Autonomy-dial AC5 mixed-tier task (must stay pending)';
      const taskIntent = 'Autonomy-dial AC5 createTask intent';
      const assignIntent = 'Autonomy-dial AC5 assignPeople intent';
      const createTaskFixture = createTaskAction(taskTitle, taskIntent);
      const assignPeopleFixture = assignPeopleAction(
        newObjectId(),
        'assignees',
        [randomUUID()],
        assignIntent,
      );

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        createTaskFixture,
        assignPeopleFixture,
      ]);

      expect(result.parseError).toBe(false);
      expect(result.autonomousResults).toBeUndefined();

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.decided_at).toBeNull();
      const actions = row?.actions as ProposedActionContract[];
      expect(actions.map((a) => a.actionId).sort()).toEqual(
        [createTaskFixture.actionId, assignPeopleFixture.actionId].sort(),
      );

      expect(await findObjectByTitle(workspaceId, taskTitle)).toBeUndefined();

      const records = await getLedgerRecords(workspaceId);
      expect(findRecordByIntent(records, taskIntent)).toBeUndefined();
      expect(findRecordByIntent(records, assignIntent)).toBeUndefined();
    });
  });

  // =======================================================================
  // 6. Governance floor unbypassable
  // =======================================================================

  describe('6. reconfigureAgentPermissions can never be auto-decided (ADR-0039 governance floor)', () => {
    it('AutonomyTierSettingsService.set refuses to raise it above "propose", and a reconfigureAgentPermissions proposal always lands pending, requiring a real human decide()', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac6');
      const adminActor: Actor = { type: 'user', id: randomUUID() };

      await expect(
        autonomyTierSettingsService.set(
          workspaceId,
          'reconfigureAgentPermissions',
          'approve_and_act',
          adminActor,
          'admin',
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        autonomyTierSettingsService.set(
          workspaceId,
          'reconfigureAgentPermissions',
          'act_and_notify',
          adminActor,
          'admin',
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const intent = 'Autonomy-dial AC6 reconfigure intent';
      const action = reconfigureAction('autonomy-dial-ac6-agent', intent);

      const result = await service.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, [
        action,
      ]);

      expect(result.parseError).toBe(false);
      expect(result.autonomousResults).toBeUndefined();

      const row = await getProposalRow(result.proposalId);
      expect(row).toBeDefined();
      expect(row?.decided_at).toBeNull();
      expect(row?.actions).toEqual([action]);

      const records = await getLedgerRecords(workspaceId);
      expect(findRecordByIntent(records, intent)).toBeUndefined();
    });
  });

  // =======================================================================
  // 7. Human decide() path untouched -- provenance regression guard
  // =======================================================================

  describe('7. a plain human decide() call (never AUTONOMY_DIAL_ACTOR)', () => {
    it('still writes provenance "decided" with the real approver as actor, exactly as before this PR', async () => {
      const workspaceId = await createWorkspace('autonomy-dial-ac7');
      const approverActor: Actor = { type: 'user', id: randomUUID() };
      const triggerId = newObjectId();
      const sourceObjectId = newObjectId();
      const title = 'Autonomy-dial AC7 human-decided task';
      const intent = 'Autonomy-dial AC7 intent';
      const action = createTaskAction(title, intent);

      const proposeResult = await service.proposeFromTrigger(
        workspaceId,
        triggerId,
        sourceObjectId,
        [action],
      );
      expect(proposeResult.parseError).toBe(false);

      const { results } = await service.decide(
        workspaceId,
        proposeResult.proposalId,
        approverActor,
        'owner',
        [{ actionId: action.actionId, decision: 'approved' }],
      );

      expect(results).toEqual([{ actionId: action.actionId, status: 'executed' }]);

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.provenance).toBe('decided');
      expect(record?.actor).toEqual(approverActor);
      expect(record?.actor).not.toEqual(AUTONOMY_DIAL_ACTOR);
    });
  });
});
