import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Role } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';
import { objectsView } from '../db/schema/objects-view.js';
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
 * F2-T14 PR4 (RED step), ADR-0031 §h — `CommandsService.executeCreateTaskFromMeeting`,
 * the REAL executor replacing PR3's placeholder `case 'createTaskFromMeeting'`
 * (today: `{status:'failed', error:'This action is not yet supported.'}`,
 * unconditionally, `./commands.service.ts`'s `executeDecidedAction` switch).
 *
 * Deliberately a SIBLING file to `./commands.service.decide.integration.test.ts`
 * (PR5, already green), reusing its exact FULL-`AppModule` harness (real
 * `ObjectsService`/`RelationsService`/`WorkspaceMembershipService` pulled out
 * of a real Nest DI container via `app.get(...)`, then `CommandsService`
 * manually `new`'d with those real instances) — this PR's
 * `executeCreateTaskFromMeeting` needs a REAL `ObjectsService.create`/
 * `setFieldValues` (task creation + best-effort field application), so the
 * lightweight 5-dep harness (`./commands.service.propose-from-meeting.integration.test.ts`,
 * this same PR's OTHER new file) is not enough here.
 *
 * Every `createTaskFromMeeting` proposal below is seeded via
 * `service.proposeFromMeeting(...)` (already covered in isolation by this
 * PR's sibling file above) rather than a raw event-store insert — mirrors
 * `commands.service.decide.integration.test.ts`'s own `parseAndGetActions`
 * convention of reusing the already-tested "propose" half to set up
 * `decide()`'s own tests.
 *
 * RED STATE (expected, today): `executeDecidedAction`'s `createTaskFromMeeting`
 * branch unconditionally returns `{status:'failed', error:'This action is not
 * yet supported.'}` — every test below expecting `status: 'executed'` is
 * expected to fail against that placeholder, which is the correct RED
 * failure reason (not a typo in these tests). `proposeFromMeeting` itself
 * (this PR's OTHER addition) must also exist for `beforeAll`/each test's own
 * setup step to succeed at all — see this file's sibling for that method's
 * own dedicated coverage.
 *
 * ============================================================================
 * DESIGN NOTES (test-writer judgment calls):
 *
 * - Per ADR-0031's human-approved "Açık Soru 1", `assigneeHint` resolution is
 *   EXACT-MATCH-ONLY on `users.email` (case-insensitive) — AC-assignee-2
 *   below deliberately submits the hint in a DIFFERENT case than the real
 *   member's stored email to pin the case-insensitivity requirement.
 * - `dueDateHint` resolution is `Date.parse`-only (Açık Soru 1) — AC-due-2
 *   below uses `'next week'`, a relative expression `Date.parse` cannot
 *   parse, specifically BECAUSE it is the kind of input the ADR's human
 *   decision says must be REJECTED (not a fuzzy/partial acceptance).
 * - Every hint-related test defines (or deliberately omits) the `assignee`/
 *   `dueDate` field definitions on `task` explicitly — this codebase does not
 *   auto-seed either of them (only `status` is auto-seeded, per
 *   `commands.service.decide.integration.test.ts`'s own header comment), so
 *   "no active field definition" is simply the default state whenever a test
 *   does not call `defineField` for that key.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';
const RETURN_MARKER = 'RETURN:';

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

/** The public contract `CommandsService` must satisfy once `implementer`
 * adds `proposeFromMeeting`/`executeCreateTaskFromMeeting` — declared
 * locally, same reasoning as every other file in this directory. */
interface CommandsServiceContract {
  proposeFromMeeting(
    workspaceId: string,
    meetingObjectId: string,
    transcriptText: string,
  ): Promise<CommandsServiceParseResult>;
  decide(
    workspaceId: string,
    proposalId: string,
    approverActor: Actor,
    callerRole: Role,
    decisions: DecisionInput[],
  ): Promise<{ results: DecideActionResult[] }>;
}

/** Same 8-arg constructor shape `./commands.service.decide.integration.test.ts`
 * already pins (PR5) -- this PR adds no NEW constructor dependency. */
type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: AIUsageService,
  aiProvider: AIProvider,
  objectsService: ObjectsService,
  relationsService: RelationsService,
  workspaceMembershipService: WorkspaceMembershipService,
) => CommandsServiceContract;

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
  return `ctfm-test-user-${String(emailCounter)}@example.com`;
}

describe('CommandsService.executeCreateTaskFromMeeting() via decide() (F2-T14 PR4, real Postgres + real Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let objectsService: ObjectsService;
  let relationsService: RelationsService;
  let workspaceMembershipService: WorkspaceMembershipService;
  let aiUsageService: AIUsageService;
  let aiProvider: AIProvider;
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
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

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

  async function createWorkspace(cookie: string, name: string): Promise<string> {
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
    const workspaceId = await createWorkspace(cookie, `CTFM Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId, ownerUserId: userId };
  }

  /** Mirrors `./commands.service.decide.integration.test.ts`'s own
   * `addMemberWithRole` -- there is no HTTP invite endpoint, so a real
   * non-owner membership row is fabricated directly via the register+DI-DB
   * combo. Unlike that precedent, this file ALSO needs the member's real
   * `email` (to use as an `assigneeHint`), so this is a distinct helper
   * rather than a verbatim copy. */
  async function addWorkspaceMember(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ userId: string; email: string }> {
    const { userId, email } = await registerUser();
    await db.insert(memberships).values({ workspaceId, userId, role });
    return { userId, email };
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
      defaultValue?: unknown;
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

  /** Same `RETURN:<json>` marker convention as this PR's sibling file
   * (`./commands.service.propose-from-meeting.integration.test.ts`). */
  function scriptedTranscript(actions: Record<string, unknown>[]): string {
    return `Meeting notes. ${RETURN_MARKER}${JSON.stringify(actions)}`;
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

  /** `proposeFromMeeting()` a scripted transcript and assert it succeeded --
   * the shared proposal-setup step every test below needs before it can call
   * `decide()`. Mirrors `commands.service.decide.integration.test.ts`'s own
   * `parseAndGetActions` convention, but sourced from `proposeFromMeeting`
   * instead of `parse()`. */
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

  async function findObjectByTitle(workspaceId: string, title: string) {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    const found = objects.find((object) => object.title === title);
    if (!found) {
      throw new Error(`Test bug: expected an object titled "${title}" to exist`);
    }
    return found;
  }

  // ---------------------------------------------------------------------
  // AC1 -- only a title, no hints
  // ---------------------------------------------------------------------

  describe('AC1: createTaskFromMeeting with only a title (no hints)', () => {
    it('creates the task and reports executed', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'CTFM-AC1 Follow-up task';

      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title }),
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
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- assigneeHint exact match (case-insensitive email)
  // ---------------------------------------------------------------------

  describe('AC2: a valid assigneeHint matching an existing workspace member email exactly', () => {
    it('creates the task AND sets the assignee field to that member (case-insensitive email match)', async () => {
      const { cookie, workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const { userId: memberUserId, email: memberEmail } = await addWorkspaceMember(
        workspaceId,
        'member',
      );

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignee',
        label: 'Assignee',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const title = 'CTFM-AC2 Assigned task';
      // Deliberately a DIFFERENT case than the stored email, per ADR-0031's
      // "exact match, case-insensitive" human decision.
      const assigneeHint = memberEmail.toUpperCase();

      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title, assigneeHint }),
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
      const updated = await objectsService.get(workspaceId, created.id, 'owner');
      expect(updated.fieldValues.assignee).toEqual([memberUserId]);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- assigneeHint with no matching member
  // ---------------------------------------------------------------------

  describe('AC3: an assigneeHint that does not match any workspace member email', () => {
    it('still creates the task and reports executed, but never writes the assignee field', async () => {
      const { cookie, workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignee',
        label: 'Assignee',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const title = 'CTFM-AC3 No matching member';
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
      const updated = await objectsService.get(workspaceId, created.id, 'owner');
      expect(updated.fieldValues.assignee).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- assigneeHint matches a real email, but no active "assignee" field
  // definition exists at all
  // ---------------------------------------------------------------------

  describe('AC4: a matching assigneeHint when the task type has no active "assignee" field definition', () => {
    it('still creates the task and reports executed, with no error surfacing', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      // Deliberately NOT calling defineField for "assignee" -- this
      // workspace's `task` type has no such field definition at all, the
      // codebase's default state.
      const { email: memberEmail } = await addWorkspaceMember(workspaceId, 'member');

      const title = 'CTFM-AC4 No field definition at all';
      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title, assigneeHint: memberEmail }),
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
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- valid ISO-8601 dueDateHint
  // ---------------------------------------------------------------------

  describe('AC5: a valid ISO-8601 dueDateHint with an active "dueDate" field definition', () => {
    it('creates the task AND sets the dueDate field', async () => {
      const { cookie, workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      await defineField(cookie, workspaceId, 'task', {
        key: 'dueDate',
        label: 'Due Date',
        fieldType: 'date',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const title = 'CTFM-AC5 Due date task';
      const dueDateHint = '2026-12-01';

      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title, dueDateHint }),
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
      const updated = await objectsService.get(workspaceId, created.id, 'owner');
      expect(updated.fieldValues.dueDate).toBeDefined();
      expect(new Date(updated.fieldValues.dueDate as string).getTime()).toBe(
        new Date(dueDateHint).getTime(),
      );
    });
  });

  // ---------------------------------------------------------------------
  // AC6 -- unparseable dueDateHint (relative expression, per ADR-0031's
  // "Date.parse only" human decision)
  // ---------------------------------------------------------------------

  describe('AC6: an invalid/unparseable dueDateHint', () => {
    it('still creates the task and reports executed, but never writes the dueDate field', async () => {
      const { cookie, workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      await defineField(cookie, workspaceId, 'task', {
        key: 'dueDate',
        label: 'Due Date',
        fieldType: 'date',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const title = 'CTFM-AC6 Unparseable due date';
      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title, dueDateHint: 'next week' }),
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
      const updated = await objectsService.get(workspaceId, created.id, 'owner');
      expect(updated.fieldValues.dueDate).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC7 -- task creation itself fails (missing title)
  // ---------------------------------------------------------------------

  describe('AC7: the task itself fails to create (missing title param)', () => {
    it('reports failed, matching executeCreateTask’s own error-handling convention -- no task is created', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        // No "title" key at all in params -- `requireStringParam` must throw,
        // caught by `executeCreateTaskFromMeeting`'s own try/catch, exactly
        // like `executeCreateTask`'s existing behavior.
        createTaskFromMeetingAction({ assigneeHint: 'irrelevant@example.com' }),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { objects: objectsBefore } = await objectsService.list(workspaceId, 'owner');

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ actionId, status: 'failed' });
      expect(typeof results[0]?.error).toBe('string');

      const { objects: objectsAfter } = await objectsService.list(workspaceId, 'owner');
      expect(objectsAfter.length).toBe(objectsBefore.length);
    });
  });

  // ---------------------------------------------------------------------
  // AC8 -- ActionsDecided/ObjectCreated actor attribution (ADR-0015 §d,
  // unchanged discipline extended to this new action type)
  // ---------------------------------------------------------------------

  describe('AC8: the created task is attributed to the approving user, never MEETING_ACTION_EXTRACTOR_ACTOR or COMMAND_PARSER_ACTOR', () => {
    it('ObjectCreated’s actor is the real approving user', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'CTFM-AC8 Actor attribution';

      const { proposalId, actions } = await proposeFromMeetingAndGetActions(workspaceId, [
        createTaskFromMeetingAction({ title }),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);

      const created = await findObjectByTitle(workspaceId, title);
      const [row] = await db
        .select({ streamId: objectsView.streamId })
        .from(objectsView)
        .where(eq(objectsView.id, created.id))
        .limit(1);
      if (!row) {
        throw new Error('Test bug: expected an objects_view row to exist');
      }
      const objectEvents = await eventStore.readStream(row.streamId);
      const createdEvent = objectEvents.find((event) => event.type === 'ObjectCreated');
      expect(createdEvent?.actor).toEqual(approverActor);
      expect(createdEvent?.actor).not.toEqual({
        type: 'agent',
        id: 'meeting-action-extractor',
      });
      expect(createdEvent?.actor).not.toEqual({ type: 'agent', id: 'command-parser' });
    });
  });
});
