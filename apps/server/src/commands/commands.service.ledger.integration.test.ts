import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { agentResource, objectResource } from '@luminaos/agent-runtime';
import type { ActionResourceReference, RollbackPlan } from '@luminaos/agent-runtime';
import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Role } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';

import { AgentActionRecordsService } from '../agent-runtime/agent-action-records.service.js';
import { AgentPermissionManifestsService } from '../agent-runtime/agent-permission-manifests.service.js';
import { AutonomyTierSettingsService } from '../agent-runtime/autonomy-tier-settings.service.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { CommentsService } from '../comments/object-comments.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { AIUsageService } from '../ai/ai-usage.service.js';
import type { Database } from '../db/client.js';
import type { ObjectsService } from '../objects/objects.service.js';
import type { RelationsService } from '../relations/relations.service.js';
import type { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';
import type { INestApplication, Type } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T4 PR2 (RED step), ADR-0038 Karar (c)/(f)/(g), spec
 * `docs/specs/F3-E2/F3-T4-ajan-aksiyon-kayit-defteri.md` PR2 section —
 * `CommandsService.decide()`'s `executeXxx`-wide wiring of every approved
 * (and rejected) decision into `AgentActionRecordsService.record()`'s unified
 * ledger. `AgentActionRecordsService` itself (PR1, `./agent-action-records.service.ts`)
 * is ALREADY MERGED and imported here STATICALLY, as a REAL collaborator
 * (never mocked) — only `CommandsService`'s OWN wiring into it is under test.
 *
 * Deliberately a SIBLING file to `./commands.service.decide.integration.test.ts`
 * / `./commands.service.execute-create-task-from-meeting.integration.test.ts`,
 * reusing their exact FULL-`AppModule` harness (real Postgres 16 + Redis 7 via
 * Testcontainers, `Test.createTestingModule({imports:[AppModule]})`, real
 * `ObjectsService`/`RelationsService`/`WorkspaceMembershipService`/
 * `AgentPermissionManifestsService`/`AgentActionRecordsService` pulled out of
 * that real DI container via `app.get(...)`, then `CommandsService` manually
 * `new`'d with those real instances) — every one of the 6 action types this
 * file exercises needs a REAL downstream collaborator (`ObjectsService`,
 * `RelationsService`, or `AgentPermissionManifestsService`), so no lighter
 * harness suffices for a single file covering all 6 at once.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of `CommandsService`'s 6 `executeXxx`
 * methods call `AgentActionRecordsService.record(...)` at all — the
 * constructor does not yet accept a 10th `agentActionRecordsService` param
 * either. Constructing `CommandsServiceCtor` below with a 10th argument is
 * harmless at the JS call-site (a real `new` call silently ignores an extra
 * constructor argument the class itself never declared) — so the RED failure
 * this file relies on is NOT "the constructor throws/rejects the extra arg",
 * it is the much more robust, implementation-agnostic runtime assertion this
 * file makes throughout: after every `decide()` call, `AgentActionRecordsService.
 * list(workspaceId, 'member')` is expected to contain a matching new record,
 * and today it NEVER does (todays's `executeXxx` methods never call
 * `.record()` at all) — every `it` below that asserts `record` `.toBeDefined()`
 * fails today for that exact reason, which is the correct RED failure mode,
 * not a bug in this test file. This mirrors this task's own documented
 * fallback guidance ("more robustly for a RED-state integration test, simply
 * assert on `AgentActionRecordsService.list()` returning NO matching record
 * after a `decide()` call").
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely — see
 * this PR's own task description for the full per-action-type table; only
 * reproduced in brief per test below):
 *
 * - EVERY ledger record written from this path has `provenance:'decided'`,
 *   `actor` = the REAL `decide()`-time `approverActor` (never a fixed
 *   system/proposal-source actor), `intent`/`rationale` copied verbatim from
 *   the decided proposal's own stored action data, and `causationEventId` =
 *   the real `ActionsDecided` event's own id for that `decide()` call — NEVER
 *   null on this path (unlike the autonomous PR3 path).
 * - `resources[]`/`rollbackPlan`/`resultRef` are ALWAYS built from each
 *   `executeXxx`'s OWN structurally-known concrete ids (the object it just
 *   created, the `objectId`/`agentIdentifier` param it validated) — NEVER
 *   from the AI-proposal's own free-text `action.resources`/`rollbackNote`
 *   strings (ADR-0038 §f). Pinned explicitly by the "structural-resources
 *   discipline" describe block below.
 * - A `decision:'rejected'` entry (never reaching any `executeXxx`) ALSO gets
 *   a ledger record: `outcome:'rejected'`, `resources:[]`,
 *   `rollbackPlan:{kind:'none', description:<non-empty>}`, `resultRef:null`.
 * - A single multi-decision `decide()` call writes ONE record per decision,
 *   all sharing the exact same non-null `causationEventId`.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';
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
  createdCount?: number;
  totalCount?: number;
  failedAtStep?: number;
  error?: string;
}

/** The public contract `CommandsService` must satisfy once `implementer` adds
 * this PR's wiring — declared locally, same reasoning as every other file in
 * this directory. Every `propose*` method this file needs is already merged
 * (F1-T16/F2-T14/F2-T15/F3-T3); only `decide()`'s INTERNAL ledger-wiring
 * behavior is new. */
interface CommandsServiceContract {
  parse(
    workspaceId: string,
    actor: Actor,
    command: string,
    sourceObjectId?: string,
  ): Promise<CommandsServiceParseResult>;
  proposeFromMeeting(
    workspaceId: string,
    meetingObjectId: string,
    transcriptText: string,
  ): Promise<CommandsServiceParseResult>;
  proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string,
    actions: ProposedActionContract[],
  ): Promise<CommandsServiceParseResult>;
  proposeFromDirectMessage(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    agentIdentifier: string,
    dmMessageText: string,
  ): Promise<CommandsServiceParseResult>;
  decide(
    workspaceId: string,
    proposalId: string,
    approverActor: Actor,
    callerRole: Role,
    decisions: DecisionInput[],
  ): Promise<{ results: DecideActionResult[] }>;
}

/** This PR's own pinned constructor shape: the CURRENT 9 args (the last of
 * which, `agentPermissionManifestsService`, F3-T3 PR4) PLUS a 10th
 * `agentActionRecordsService`, PLUS (F3-T5 PR2, ADR-0039) an 11th
 * `autonomyTierSettingsService` and a 12th (and final) `commentsService` --
 * `CommandsService.routeProposedActions` reads both of these on EVERY
 * `propose*` call, so this file's own manual `new CommandsServiceCtor(...)`
 * call must supply real instances (never `undefined`), even though none of
 * this file's own scenarios configure a non-default autonomy tier. */
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

/** A field-for-field local copy of `AgentActionRecord`, mirroring
 * `agent-action-records.service.integration.test.ts` (PR1b)'s own
 * `AgentActionRecordContract` convention. */
interface AgentActionRecordContract {
  id: string;
  workspaceId: string;
  provenance: 'decided' | 'autonomous';
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  occurredAt: Date;
}

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface FieldDefinitionBody {
  id: string;
  key: string;
  objectType: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface RawProposalRow {
  id: string;
  stream_id: string;
}

const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `ledger-test-user-${String(emailCounter)}@example.com`;
}

describe('CommandsService decide()-path ledger wiring (F3-T4 PR2, real Postgres + real Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
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
    server = app.getHttpServer() as Server;

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

    // Both ALREADY MERGED (F3-T3 PR4 / F3-T4 PR1) -- real instances pulled
    // straight out of the real DI container, statically imported at this
    // file's top (unlike `CommandsService` itself, these are never RED).
    agentPermissionManifestsService = app.get(AgentPermissionManifestsService);
    agentActionRecordsService = app.get(AgentActionRecordsService);
    // F3-T5 PR2 (ADR-0039): also already-merged real instances, pulled
    // straight out of the real DI container -- `CommandsService` never
    // configures a non-default autonomy tier in this file's own scenarios,
    // so `resolveTier`'s fail-safe `'propose'` default keeps every
    // `routeProposedActions` call here behaving exactly as before this PR.
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

  // ---------------------------------------------------------------------
  // Shared setup helpers (mirroring the established conventions of the
  // sibling `commands.service.*.integration.test.ts` files in this
  // directory)
  // ---------------------------------------------------------------------

  async function registerUser(): Promise<{ cookie: string; userId: string; email: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId, email };
  }

  async function createWorkspaceHttp(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    workspaceId: string;
    ownerUserId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspaceHttp(
      cookie,
      `Ledger Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId, ownerUserId: userId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ userId: string }> {
    const { userId } = await registerUser();
    await db.insert(memberships).values({ workspaceId, userId, role });
    return { userId };
  }

  function fieldsUrl(workspaceId: string, objectType: string): string {
    return `/workspaces/${workspaceId}/object-types/${objectType}/fields`;
  }

  async function defineField(
    cookie: string,
    workspaceId: string,
    objectType: string,
    body: {
      key: string;
      label: string;
      fieldType: string;
      config: unknown;
      permissions: FieldPermissionsBody;
    },
  ): Promise<FieldDefinitionBody> {
    const response = await request(server)
      .post(fieldsUrl(workspaceId, objectType))
      .set('Cookie', cookie)
      .send(body);

    expect(response.status).toBe(201);
    return (response.body as FieldDefinitionEnvelope).fieldDefinition;
  }

  function scriptedActionsCommand(actions: Record<string, unknown>[]): string {
    return `Please act on this. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function scriptedTranscript(actions: Record<string, unknown>[]): string {
    return `Meeting notes. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function scriptedDmMessage(actions: Record<string, unknown>[]): string {
    return `Please reconfigure the agent. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function createTaskAction(
    title: string,
    intent = 'Create a follow-up task',
  ): Record<string, unknown> {
    return {
      type: 'createTask',
      intent,
      rationale: 'The user asked for one',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: { title },
    };
  }

  function createTaskActionMissingTitle(intent: string): Record<string, unknown> {
    return {
      type: 'createTask',
      intent,
      rationale: 'This one is deliberately missing its title param',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: {},
    };
  }

  function createTaskActionWithFakeResources(
    title: string,
    intent: string,
  ): Record<string, unknown> {
    return {
      type: 'createTask',
      intent,
      rationale: 'Nonsense-mismatched resources/rollbackNote must never leak into the ledger',
      // Deliberately fake/mismatched free-text -- ADR-0038 §f: the ledger
      // must NEVER derive resources/rollbackPlan from these AI-authored
      // strings, only from the REAL created object id.
      resources: ['totally-fake-id-999'],
      rollbackNote: 'nonsense text',
      params: { title },
    };
  }

  function generateSubtasksAction(
    parentObjectId: string,
    subtaskTitles: string[],
  ): Record<string, unknown> {
    return {
      type: 'generateSubtasks',
      intent: 'Break the task into subtasks',
      rationale: 'The user asked for a breakdown',
      resources: [parentObjectId],
      rollbackNote: 'Delete the created subtasks and their relations',
      params: { parentObjectId, subtaskTitles },
    };
  }

  function assignPeopleAction(
    objectId: string,
    fieldKey: string,
    userIds: string[],
  ): Record<string, unknown> {
    return {
      type: 'assignPeople',
      intent: 'Assign people to the object',
      rationale: 'The user asked for specific assignees',
      resources: [objectId],
      rollbackNote: 'Unassign the people',
      params: { objectId, fieldKey, userIds },
    };
  }

  function createTaskFromMeetingAction(params: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'createTaskFromMeeting',
      intent: 'Create a follow-up task from the meeting',
      rationale: 'The transcript named a concrete action item',
      resources: [],
      rollbackNote: 'Delete the created task',
      params,
    };
  }

  function createTaskFromTriggerAction(params: Record<string, unknown>): ProposedActionContract {
    return {
      actionId: randomUUID(),
      type: 'createTaskFromTrigger',
      intent: 'Create a task from a matched trigger',
      rationale: 'The trigger condition matched and its action template requested a task',
      resources: [],
      rollbackNote: 'Delete the created task',
      params,
    };
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

  async function parseAndGetActions(
    workspaceId: string,
    actions: Record<string, unknown>[],
  ): Promise<{ proposalId: string; actions: ProposedActionContract[] }> {
    const command = scriptedActionsCommand(actions);
    const result = await service.parse(
      workspaceId,
      { type: 'user', id: 'command-caller' },
      command,
    );
    expect(result.parseError).toBe(false);
    return { proposalId: result.proposalId, actions: result.actions };
  }

  async function proposeFromMeetingAndGetActions(
    workspaceId: string,
    actions: Record<string, unknown>[],
  ): Promise<{ proposalId: string; actions: ProposedActionContract[] }> {
    const meetingObjectId = newObjectId();
    const transcriptText = scriptedTranscript(actions);
    const result = await service.proposeFromMeeting(workspaceId, meetingObjectId, transcriptText);
    expect(result.parseError).toBe(false);
    return { proposalId: result.proposalId, actions: result.actions };
  }

  async function proposeFromTriggerAndGetActions(
    workspaceId: string,
    actions: ProposedActionContract[],
  ): Promise<{ proposalId: string; actions: ProposedActionContract[] }> {
    const triggerId = newObjectId();
    const sourceObjectId = newObjectId();
    const result = await service.proposeFromTrigger(
      workspaceId,
      triggerId,
      sourceObjectId,
      actions,
    );
    expect(result.parseError).toBe(false);
    return { proposalId: result.proposalId, actions: result.actions };
  }

  async function proposeFromDirectMessageAndGetActions(
    workspaceId: string,
    adminActor: Actor,
    agentIdentifier: string,
    actions: Record<string, unknown>[],
  ): Promise<{ proposalId: string; actions: ProposedActionContract[] }> {
    const dmMessageText = scriptedDmMessage(actions);
    const result = await service.proposeFromDirectMessage(
      workspaceId,
      adminActor,
      'admin',
      agentIdentifier,
      dmMessageText,
    );
    expect(result.parseError).toBe(false);
    return { proposalId: result.proposalId, actions: result.actions };
  }

  async function getProposalRow(proposalId: string): Promise<RawProposalRow | undefined> {
    const result = await db.$client.query<RawProposalRow>(
      'select id, stream_id from command_proposals where id = $1',
      [proposalId],
    );
    return result.rows[0];
  }

  /** Fetches the real `ActionsDecided` event's own id for `proposalId` --
   * this is the exact, non-null `causationEventId` value every ledger record
   * written from a `decide()` call is expected to share. */
  async function getActionsDecidedEventId(proposalId: string): Promise<string> {
    const row = await getProposalRow(proposalId);
    if (!row) {
      throw new Error('Test bug: expected a command_proposals row to exist');
    }
    const events = await eventStore.readStream(row.stream_id);
    const decidedEvent = events.find((event) => event.type === 'ActionsDecided');
    if (!decidedEvent) {
      throw new Error('Test bug: expected an ActionsDecided event to exist on this stream');
    }
    return decidedEvent.id;
  }

  async function findObjectByTitle(workspaceId: string, title: string) {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    const found = objects.find((object) => object.title === title);
    if (!found) {
      throw new Error(`Test bug: expected an object titled "${title}" to exist`);
    }
    return found;
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

  function expectNonEmptyString(value: unknown): void {
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
  }

  // =======================================================================
  // 1. createTask
  // =======================================================================

  describe('1. executeCreateTask ledger wiring', () => {
    it('success: records provenance decided, real approver actor, real created objectId as resources/rollbackPlan/resultRef, outcome succeeded, non-null causationEventId shared with the real ActionsDecided event', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'Ledger createTask success';
      const intent = 'Ledger createTask success intent';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(title, intent),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const created = await findObjectByTitle(workspaceId, title);
      const decidedEventId = await getActionsDecidedEventId(proposalId);

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.provenance).toBe('decided');
      expect(record?.actor).toEqual(approverActor);
      expect(record?.actionType).toBe('createTask');
      expect(record?.intent).toBe(intent);
      expect(record?.rationale).toBe('The user asked for one');
      expect(record?.resources).toEqual([objectResource(created.id)]);
      expect(record?.rollbackPlan.kind).toBe('delete');
      expect(record?.rollbackPlan.targetResource).toEqual(objectResource(created.id));
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toEqual(objectResource(created.id));
      expect(record?.outcome).toBe('succeeded');
      expect(record?.causationEventId).toBe(decidedEventId);
      expect(record?.causationEventId).not.toBeNull();
    });

    it('failure (missing title param): records empty resources, rollbackPlan kind none, null resultRef, outcome failed', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const intent = 'Ledger createTask failure intent';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskActionMissingTitle(intent),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([]);
      expect(record?.rollbackPlan.kind).toBe('none');
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('failed');
    });
  });

  // =======================================================================
  // 2. createTaskFromTrigger
  // =======================================================================

  describe('2. executeCreateTaskFromTrigger ledger wiring (identical shape to createTask)', () => {
    it('success: records the real created objectId as resources/rollbackPlan/resultRef, outcome succeeded', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'Ledger createTaskFromTrigger success';

      const { proposalId, actions } = await proposeFromTriggerAndGetActions(workspaceId, [
        createTaskFromTriggerAction({ title }),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const created = await findObjectByTitle(workspaceId, title);
      const decidedEventId = await getActionsDecidedEventId(proposalId);

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'createTaskFromTrigger');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([objectResource(created.id)]);
      expect(record?.rollbackPlan.kind).toBe('delete');
      expect(record?.rollbackPlan.targetResource).toEqual(objectResource(created.id));
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toEqual(objectResource(created.id));
      expect(record?.outcome).toBe('succeeded');
      expect(record?.causationEventId).toBe(decidedEventId);
    });

    it('failure (missing title param): records empty resources/rollbackPlan none/null resultRef/outcome failed', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const { proposalId, actions } = await proposeFromTriggerAndGetActions(workspaceId, [
        createTaskFromTriggerAction({}),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'createTaskFromTrigger');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([]);
      expect(record?.rollbackPlan.kind).toBe('none');
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('failed');
    });
  });

  // =======================================================================
  // 3. createTaskFromMeeting
  // =======================================================================

  describe('3. executeCreateTaskFromMeeting ledger wiring', () => {
    it('a bad/unresolvable assigneeHint still yields outcome succeeded, with the same resources/resultRef as if no hint had been given', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'Ledger createTaskFromMeeting bad hint';

      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title, assigneeHint: 'nobody-such-person@example.com' }),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const created = await findObjectByTitle(workspaceId, title);

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'createTaskFromMeeting');
      expect(record).toBeDefined();
      expect(record?.outcome).toBe('succeeded');
      expect(record?.resources).toEqual([objectResource(created.id)]);
      expect(record?.resultRef).toEqual(objectResource(created.id));
      expect(record?.rollbackPlan.kind).toBe('delete');
      expect(record?.rollbackPlan.targetResource).toEqual(objectResource(created.id));
    });
  });

  // =======================================================================
  // 4. generateSubtasks
  // =======================================================================

  describe('4. executeGenerateSubtasks ledger wiring', () => {
    it('full success: records every created subtask id in order, rollbackPlan kind delete with NO targetResource, null resultRef, outcome succeeded', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const parent = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'Ledger GS full success parent' },
        'owner',
      );
      const subtaskTitles = [
        'Ledger GS full success subtask 1',
        'Ledger GS full success subtask 2',
        'Ledger GS full success subtask 3',
      ];

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        generateSubtasksAction(parent.id, subtaskTitles),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const createdInOrder = await Promise.all(
        subtaskTitles.map((title) => findObjectByTitle(workspaceId, title)),
      );

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'generateSubtasks');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual(createdInOrder.map((object) => objectResource(object.id)));
      // NO `targetResource` at all for a multi-resource action (ADR-0038
      // §g) -- checked explicitly via `not.toHaveProperty`, so this also
      // fails if the implementation mistakenly picks a single arbitrary
      // subtask as `targetResource`.
      expect(record?.rollbackPlan.kind).toBe('delete');
      expect(record?.rollbackPlan).not.toHaveProperty('targetResource');
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('succeeded');
    });

    it('partial failure: records ONLY the ids actually created before the failing step, outcome partially_succeeded', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const parent = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'Ledger GS partial failure parent' },
        'owner',
      );
      const subtaskTitles = [
        'Ledger GS partial failure subtask 1',
        'Ledger GS partial failure subtask 2',
        'Ledger GS partial failure subtask 3',
      ];

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        generateSubtasksAction(parent.id, subtaskTitles),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      let createCallCount = 0;
      const originalCreate = objectsService.create.bind(objectsService);
      const createSpy = vi
        .spyOn(objectsService, 'create')
        .mockImplementation(async (workspaceIdArg, actorArg, inputArg, callerRoleArg) => {
          createCallCount += 1;
          if (createCallCount === 2) {
            throw new Error('Simulated failure creating the 2nd subtask');
          }
          return originalCreate(workspaceIdArg, actorArg, inputArg, callerRoleArg);
        });

      let results: DecideActionResult[];
      try {
        ({ results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
          { actionId, decision: 'approved' },
        ]));
      } finally {
        createSpy.mockRestore();
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'partially_executed', createdCount: 1 });

      const survivingSubtask = await findObjectByTitle(workspaceId, subtaskTitles[0] as string);

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'generateSubtasks');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([objectResource(survivingSubtask.id)]);
      expect(record?.outcome).toBe('partially_succeeded');
      expect(record?.resultRef).toBeNull();
    });

    it('total failure (first subtask fails, zero created): records empty resources, outcome failed', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const parent = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'Ledger GS total failure parent' },
        'owner',
      );
      const subtaskTitles = [
        'Ledger GS total failure subtask 1',
        'Ledger GS total failure subtask 2',
      ];

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        generateSubtasksAction(parent.id, subtaskTitles),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const createSpy = vi
        .spyOn(objectsService, 'create')
        .mockRejectedValue(new Error('Simulated failure creating the 1st subtask'));

      let results: DecideActionResult[];
      try {
        ({ results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
          { actionId, decision: 'approved' },
        ]));
      } finally {
        createSpy.mockRestore();
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'generateSubtasks');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([]);
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('failed');
    });
  });

  // =======================================================================
  // 5. assignPeople (gains the new causationEventId param this PR)
  // =======================================================================

  describe('5. executeAssignPeople ledger wiring (closes the causationEventId gap)', () => {
    it('success: records the target objectId as resources/rollbackPlan/resultRef, kind revertFieldValue, outcome succeeded, real causationEventId', async () => {
      const { cookie, workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const { userId: memberUserId } = await addMemberWithRole(workspaceId, 'member');

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignees',
        label: 'Assignees',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const target = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'Ledger assignPeople success target' },
        'owner',
      );

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        assignPeopleAction(target.id, 'assignees', [memberUserId]),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const decidedEventId = await getActionsDecidedEventId(proposalId);

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'assignPeople');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([objectResource(target.id)]);
      expect(record?.rollbackPlan.kind).toBe('revertFieldValue');
      expect(record?.rollbackPlan.targetResource).toEqual(objectResource(target.id));
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toEqual(objectResource(target.id));
      expect(record?.outcome).toBe('succeeded');
      expect(record?.causationEventId).toBe(decidedEventId);
      expect(record?.causationEventId).not.toBeNull();
    });

    it('failure (target userId is not a workspace member): records empty resources/rollbackPlan none/null resultRef/outcome failed', async () => {
      const { cookie, workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const nonMemberUserId = randomUUID();

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignees',
        label: 'Assignees',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const target = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'Ledger assignPeople failure target' },
        'owner',
      );

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        assignPeopleAction(target.id, 'assignees', [nonMemberUserId]),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'assignPeople');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([]);
      expect(record?.rollbackPlan.kind).toBe('none');
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('failed');
    });
  });

  // =======================================================================
  // 6. reconfigureAgentPermissions (gains the new causationEventId param
  // this PR)
  // =======================================================================

  describe('6. executeReconfigureAgentPermissions ledger wiring (closes the causationEventId gap)', () => {
    it('grant success: records agentResource(agentIdentifier) as resources/resultRef, rollbackPlan kind revokePermission, outcome succeeded', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      const agentIdentifier = 'ledger-grant-agent-1';

      const { proposalId, actions } = await proposeFromDirectMessageAndGetActions(
        workspaceId,
        adminActor,
        agentIdentifier,
        [
          reconfigureActionJson({
            agentIdentifier,
            operation: 'grant',
            dataScope: { objectTypes: 'all' },
            actionTypes: ['answer-question'],
            timeWindow: { startsAt: null, expiresAt: null },
          }),
        ],
      );
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const decidedEventId = await getActionsDecidedEventId(proposalId);

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'reconfigureAgentPermissions');
      expect(record).toBeDefined();
      expect(record?.actor).toEqual(adminActor);
      expect(record?.resources).toEqual([agentResource(agentIdentifier)]);
      expect(record?.rollbackPlan.kind).toBe('revokePermission');
      expect(record?.rollbackPlan.targetResource).toEqual(agentResource(agentIdentifier));
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toEqual(agentResource(agentIdentifier));
      expect(record?.outcome).toBe('succeeded');
      expect(record?.causationEventId).toBe(decidedEventId);
    });

    it('revoke success: records agentResource(agentIdentifier) as resources/resultRef, rollbackPlan kind manual (v0 YAGNI, ADR-0038 §g/Human Decision 3), outcome succeeded', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      const agentIdentifier = 'ledger-revoke-agent-1';

      await agentPermissionManifestsService.grant(workspaceId, adminActor, 'admin', {
        agentIdentifier,
        dataScope: { objectTypes: 'all' },
        actionTypes: ['answer-question'],
        timeWindow: { startsAt: null, expiresAt: null },
      });

      const { proposalId, actions } = await proposeFromDirectMessageAndGetActions(
        workspaceId,
        adminActor,
        agentIdentifier,
        [reconfigureActionJson({ agentIdentifier, operation: 'revoke' })],
      );
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'reconfigureAgentPermissions');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([agentResource(agentIdentifier)]);
      expect(record?.rollbackPlan.kind).toBe('manual');
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toEqual(agentResource(agentIdentifier));
      expect(record?.outcome).toBe('succeeded');
    });

    it('failure (unknown operation value): records empty resources/rollbackPlan none/null resultRef/outcome failed', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const adminActor: Actor = { type: 'user', id: randomUUID() };
      const agentIdentifier = 'ledger-bad-op-agent-1';

      const { proposalId, actions } = await proposeFromDirectMessageAndGetActions(
        workspaceId,
        adminActor,
        agentIdentifier,
        [reconfigureActionJson({ agentIdentifier, operation: 'destroy-everything' })],
      );
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, adminActor, 'admin', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });

      const records = await getLedgerRecords(workspaceId);
      const record = records.find((entry) => entry.actionType === 'reconfigureAgentPermissions');
      expect(record).toBeDefined();
      expect(record?.resources).toEqual([]);
      expect(record?.rollbackPlan.kind).toBe('none');
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('failed');
    });
  });

  // =======================================================================
  // 7. Rejected decisions are ALSO recorded (never reach any executeXxx)
  // =======================================================================

  describe('7. a rejected decision (never reaching any executeXxx) is also recorded', () => {
    it('records outcome rejected, empty resources, rollbackPlan kind none, null resultRef, using the proposal’s own stored action data', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'Ledger rejected decision task (must never be created)';
      const intent = 'Ledger rejected decision intent';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(title, intent),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'rejected' },
      ]);
      expect(results).toEqual([{ actionId, status: 'rejected' }]);

      const decidedEventId = await getActionsDecidedEventId(proposalId);

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      expect(record?.actionType).toBe('createTask');
      expect(record?.rationale).toBe('The user asked for one');
      expect(record?.provenance).toBe('decided');
      expect(record?.actor).toEqual(approverActor);
      expect(record?.resources).toEqual([]);
      expect(record?.rollbackPlan.kind).toBe('none');
      expectNonEmptyString(record?.rollbackPlan.description);
      expect(record?.resultRef).toBeNull();
      expect(record?.outcome).toBe('rejected');
      expect(record?.causationEventId).toBe(decidedEventId);
      expect(record?.causationEventId).not.toBeNull();
    });
  });

  // =======================================================================
  // 8. Multi-action decide() calls: one record per decision, all sharing
  // the exact same causationEventId
  // =======================================================================

  describe('8. a single decide() call with 2+ decisions writes one ledger record per decision, all sharing the same causationEventId', () => {
    it('an approved createTask + a rejected createTask in the SAME decide() call produce 2 records with an identical, non-null causationEventId', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const approvedIntent = 'Ledger multi-action approved intent';
      const rejectedIntent = 'Ledger multi-action rejected intent';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction('Ledger multi-action approved task', approvedIntent),
        createTaskAction('Ledger multi-action rejected task', rejectedIntent),
      ]);
      const [approvedAction, rejectedAction] = actions;
      if (!approvedAction || !rejectedAction) {
        throw new Error('Test bug: expected exactly 2 parsed actions');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId: approvedAction.actionId, decision: 'approved' },
        { actionId: rejectedAction.actionId, decision: 'rejected' },
      ]);
      expect(results).toEqual([
        { actionId: approvedAction.actionId, status: 'executed' },
        { actionId: rejectedAction.actionId, status: 'rejected' },
      ]);

      const decidedEventId = await getActionsDecidedEventId(proposalId);

      const records = await getLedgerRecords(workspaceId);
      const approvedRecord = findRecordByIntent(records, approvedIntent);
      const rejectedRecord = findRecordByIntent(records, rejectedIntent);

      expect(approvedRecord).toBeDefined();
      expect(rejectedRecord).toBeDefined();
      expect(approvedRecord?.causationEventId).toBe(decidedEventId);
      expect(rejectedRecord?.causationEventId).toBe(decidedEventId);
      expect(approvedRecord?.causationEventId).not.toBeNull();
      expect(approvedRecord?.causationEventId).toBe(rejectedRecord?.causationEventId);
    });
  });

  // =======================================================================
  // 9. Structural-resources discipline (ADR-0038 §f): resources[]/
  // rollbackPlan are NEVER derived from the AI-proposal's own free-text
  // resources/rollbackNote strings
  // =======================================================================

  describe('9. structural-resources discipline: resources[]/rollbackPlan are built from real structurally-known ids, never from the AI-proposal’s own free-text fields', () => {
    it('a proposal whose stored resources/rollbackNote are nonsensical/mismatched still yields a ledger record built from the REAL created objectId', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'Ledger structural discipline task';
      const intent = 'Ledger structural discipline intent';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskActionWithFakeResources(title, intent),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }
      // Sanity: this test's own fixture really does carry the nonsensical
      // free-text fields the ledger must never leak through.
      expect(actions[0]?.resources).toEqual(['totally-fake-id-999']);
      expect(actions[0]?.rollbackNote).toBe('nonsense text');

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const created = await findObjectByTitle(workspaceId, title);

      const record = findRecordByIntent(await getLedgerRecords(workspaceId), intent);
      expect(record).toBeDefined();
      // The REAL, structurally-known id -- never the fake proposal string.
      expect(record?.resources).toEqual([objectResource(created.id)]);
      expect(record?.rollbackPlan.targetResource).toEqual(objectResource(created.id));
      // Never literally the fake resources[]/rollbackNote strings.
      expect(record?.resources).not.toContainEqual({
        kind: 'external',
        label: 'totally-fake-id-999',
      });
      expect(record?.rollbackPlan.description).not.toBe('nonsense text');
    });
  });

  // =======================================================================
  // 10. Ledger-write failure never breaks the real action (ADR-0038 §c,
  // spec kabul kriteri PR2: "ledger-yazım hatasının gerçek aksiyonu
  // BOZMADIĞI")
  // =======================================================================

  describe('10. a ledger-write failure never breaks the real action/DecideActionResult', () => {
    /**
     * DESIGN NOTE (test-writer judgment call): `AgentActionRecordsService.
     * record()` is ALREADY contractually best-effort/never-throwing (PR1b,
     * verified directly by its own integration test file) -- so mocking it
     * to reject here is a defensive, implementation-agnostic check on
     * `CommandsService`'s OWN call site (it must not, say, `await` the call
     * unguarded in a way that would let a hypothetical future regression in
     * `record()`'s own contract crash `decide()`), not a new behavior of
     * `record()` itself. Because NO `executeXxx` calls `.record()` at all
     * today, this specific test is NOT expected to show RED before this PR's
     * implementation lands (mocking a never-called method has no observable
     * effect yet) -- it is included for PERMANENT regression coverage of
     * this acceptance criterion once the wiring exists, not as this file's
     * RED-proof (every other describe block above already covers that).
     */
    it('a decide() createTask call still succeeds and creates the task even if AgentActionRecordsService.record() rejects', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'Ledger write-failure safety task';

      const recordSpy = vi
        .spyOn(agentActionRecordsService, 'record')
        .mockRejectedValue(new Error('Simulated ledger write failure'));

      try {
        const { proposalId, actions } = await parseAndGetActions(workspaceId, [
          createTaskAction(title),
        ]);
        const actionId = actions[0]?.actionId;
        if (actionId === undefined) {
          throw new Error('Test bug: expected exactly one parsed action');
        }

        const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
          { actionId, decision: 'approved' },
        ]);

        expect(results).toEqual([{ actionId, status: 'executed' }]);
        const created = await findObjectByTitle(workspaceId, title);
        expect(created.type).toBe('task');
      } finally {
        recordSpy.mockRestore();
      }
    });
  });
});
