import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Role } from '@luminaos/core-objects';
import { NotFoundError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { runMigrations } from '../db/migrate.js';
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
 * F2-T15 PR3 (RED step), ADR-0032 Karar (f) — `CommandsService.executeCreateTaskFromTrigger`,
 * the REAL executor for the new `'createTaskFromTrigger'` `ProposedAction`
 * type dispatched from `executeDecidedAction`'s switch. Mirrors
 * `executeCreateTask` almost exactly (creates a task via
 * `objectsService.create(workspaceId, approverActor, {objectType:'task',
 * title, causationEventId}, callerRole)` reading `params.title`) — but with
 * NO hint resolution at all (unlike `executeCreateTaskFromMeeting`'s
 * `assigneeHint`/`dueDateHint`): ADR-0032 explicitly has no templating/hints
 * in v0, `params` only ever has `title`.
 *
 * Nothing under test here exists yet: `executeDecidedAction`'s switch has no
 * `'createTaskFromTrigger'` case at all today (not even a placeholder,
 * unlike `executeCreateTaskFromMeeting`'s PR3→PR4 history) — the switch is
 * exhaustively typed over the CURRENT 4-member union, so simply adding the
 * 5th union member (`implementer`'s first step) makes the switch
 * non-exhaustive until the new case is added too. `CommandsService.
 * proposeFromTrigger` (this same PR's OTHER addition, see this file's sibling
 * `./commands.service.propose-from-trigger.integration.test.ts`) must also
 * exist for this file's own `beforeAll`/each test's setup step to succeed at
 * all.
 *
 * Deliberately a SIBLING file to
 * `./commands.service.execute-create-task-from-meeting.integration.test.ts`,
 * reusing its exact FULL-`AppModule` harness (real `ObjectsService`/
 * `RelationsService`/`WorkspaceMembershipService` pulled out of a real Nest
 * DI container via `app.get(...)`, then `CommandsService` manually `new`'d
 * with those real instances) — this new executor needs a REAL
 * `ObjectsService.create` (task creation), so the lightweight 5-dep harness
 * (this PR's OTHER new file) is not enough here.
 *
 * Every `createTaskFromTrigger` proposal below is seeded via
 * `service.proposeFromTrigger(...)` (already covered in isolation by this
 * PR's sibling file above) rather than a raw event-store insert — mirrors
 * `commands.service.decide.integration.test.ts`'s own `parseAndGetActions`
 * convention of reusing the already-tested "propose" half to set up
 * `decide()`'s own tests. Since `proposeFromTrigger` mints no `actionId` of
 * its own (unlike `parseCommand`/`extractMeetingActions`), this file's own
 * `createTaskFromTriggerAction` fixture helper mints one via `randomUUID()`,
 * mirroring the same judgment call made in this PR's propose-from-trigger
 * sibling file.
 *
 * ============================================================================
 * DESIGN NOTES (test-writer judgment calls):
 *
 * - AC4 (cross-workspace decide() mismatch) is NOT covered anywhere else in
 *   this codebase with a REAL second workspace + REAL existing proposal (the
 *   existing `commands.service.decide.integration.test.ts`'s "AC0: a
 *   proposalId that does not exist" test uses two random, non-existent
 *   UUIDs, which only proves the "proposal genuinely doesn't exist" branch,
 *   not the "proposal exists but belongs to a DIFFERENT real workspace"
 *   branch of `decide()`'s own `row.workspaceId !== workspaceId` check
 *   (`./commands.service.ts` lines ~361-366). This file's AC4 below fills
 *   that gap using a `createTaskFromTrigger` proposal specifically, per this
 *   PR's task instructions.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

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
 * adds `proposeFromTrigger`/`executeCreateTaskFromTrigger` — declared
 * locally, same reasoning as every other file in this directory. */
interface CommandsServiceContract {
  proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string,
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

/** Same 8-arg constructor shape `./commands.service.decide.integration.test.ts`
 * (PR5) and `./commands.service.execute-create-task-from-meeting.integration.test.ts`
 * (F2-T14 PR4) already pin -- this PR adds no NEW constructor dependency. */
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

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `ctft-test-user-${String(emailCounter)}@example.com`;
}

describe('CommandsService.executeCreateTaskFromTrigger() via decide() (F2-T15 PR3, real Postgres + real Redis via Testcontainers)', () => {
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
    const workspaceId = await createWorkspace(cookie, `CTFT Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId, ownerUserId: userId };
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

  /** `proposeFromTrigger()` a fixture action array and assert it succeeded --
   * the shared proposal-setup step every test below needs before it can call
   * `decide()`. Mirrors `commands.service.decide.integration.test.ts`'s own
   * `parseAndGetActions` convention, but sourced from `proposeFromTrigger`
   * instead of `parse()`/`proposeFromMeeting()`. */
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

  async function findObjectByTitle(workspaceId: string, title: string) {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    const found = objects.find((object) => object.title === title);
    if (!found) {
      throw new Error(`Test bug: expected an object titled "${title}" to exist`);
    }
    return found;
  }

  async function countObjectsWithTitle(workspaceId: string, title: string): Promise<number> {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    return objects.filter((object) => object.title === title).length;
  }

  // ---------------------------------------------------------------------
  // AC1 -- happy path
  // ---------------------------------------------------------------------

  describe('AC1: a createTaskFromTrigger action with a valid title, approved', () => {
    it('creates a real task with that title, and returns { actionId, status: "executed" }', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'CTFT-AC1 Follow-up task';

      const action = createTaskFromTriggerAction({ title });
      const { proposalId, actions } = await proposeFromTriggerAndGetActions(workspaceId, [action]);
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
      expect(createdEvent?.actor).not.toEqual({ type: 'agent', id: 'trigger-engine' });
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- missing title param
  // ---------------------------------------------------------------------

  describe('AC2: a createTaskFromTrigger action missing params.title, approved', () => {
    it('returns { actionId, status: "failed", error: <string> } -- mirrors executeCreateTask’s requireStringParam failure contract, never throws out of decide(), and no task is created', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      // No "title" key at all -- `requireStringParam` must throw, caught by
      // `executeCreateTaskFromTrigger`'s own try/catch.
      const action = createTaskFromTriggerAction({});
      const { proposalId, actions } = await proposeFromTriggerAndGetActions(workspaceId, [action]);
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
  // AC3 -- rejection is fail-closed
  // ---------------------------------------------------------------------

  describe('AC3: a createTaskFromTrigger proposal that is REJECTED (not approved)', () => {
    it('never executes: status "rejected", no object created', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'CTFT-AC3 Should never exist';

      const action = createTaskFromTriggerAction({ title });
      const { proposalId, actions } = await proposeFromTriggerAndGetActions(workspaceId, [action]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'rejected' },
      ]);

      expect(results).toEqual([{ actionId, status: 'rejected' }]);
      expect(await countObjectsWithTitle(workspaceId, title)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- cross-workspace: decide() against a different real workspace than
  // the one the proposal belongs to
  // ---------------------------------------------------------------------

  describe('AC4: a decide() call using a DIFFERENT real workspaceId than the one the proposal belongs to', () => {
    it('throws NotFoundError (mirrors the general workspace-mismatch discipline in ./commands.service.ts’s decide()) and never executes the action', async () => {
      const { workspaceId: workspaceA, ownerUserId } = await registerOwnerWithWorkspace();
      const { workspaceId: workspaceB } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'CTFT-AC4 Cross-workspace mismatch';

      const action = createTaskFromTriggerAction({ title });
      const { proposalId, actions } = await proposeFromTriggerAndGetActions(workspaceA, [action]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      await expect(
        service.decide(workspaceB, proposalId, approverActor, 'owner', [
          { actionId, decision: 'approved' },
        ]),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await countObjectsWithTitle(workspaceA, title)).toBe(0);
      expect(await countObjectsWithTitle(workspaceB, title)).toBe(0);
    });
  });
});
