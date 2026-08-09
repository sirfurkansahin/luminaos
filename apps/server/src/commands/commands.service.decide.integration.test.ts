import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AIProvider } from '@luminaos/ai-gateway';
import type { Role } from '@luminaos/core-objects';
import { ConflictError, NotFoundError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';
import { objectsView } from '../db/schema/objects-view.js';
import { relationsView } from '../db/schema/relations-view.js';
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
 * F1-T16 PR5 (RED step), ADR-0015 §d: `CommandsService.decide()` — the
 * single most security-sensitive surface of the whole F1-T16 feature. This
 * is the FIRST place in the codebase where an AI-PROPOSED action becomes a
 * REAL state mutation, gated on explicit per-action human approval, with
 * every resulting mutation attributed to and constrained by the REAL
 * approving user's own actor/role — never an elevated "agent" identity.
 *
 * Deliberately a SIBLING file to `./commands.service.integration.test.ts`
 * (PR4, already green), not an extension of it: PR4's own file uses a
 * LIGHTWEIGHT harness (`CommandsService` manually `new`'d with only its
 * original 5 deps: `db`/`eventStore`/`projectionRunner`/`aiUsageService`/
 * `aiProvider`, no full Nest app boot, no Redis, no HTTP). `decide()`'s three
 * NEW constructor deps (`ObjectsService`/`RelationsService`/
 * `WorkspaceMembershipService`) each carry their OWN large, real dependency
 * graphs (`AIRefreshScheduler`, `TaskRecurrenceService`,
 * `TimeBlockPushService`, `SearchIndexEmbeddingScheduler`, etc.) — hand-
 * constructing all of that outside Nest DI would be a brittle, drift-prone
 * duplication of `ObjectsModule`'s own wiring. Instead, this file boots the
 * REAL `AppModule` once (mirroring `../relations/relations.integration.test.ts`
 * / `../objects/object-ai-refresh.integration.test.ts`'s exact Testcontainers
 * Postgres 16 + Redis 7 + `Test.createTestingModule({ imports: [AppModule] })`
 * pattern), pulls the REAL `ObjectsService`/`RelationsService`/
 * `WorkspaceMembershipService`/`AIUsageService`/`AI_PROVIDER` instances out of
 * that real DI container via `app.get(...)`, and only then manually `new`s
 * `CommandsService` with those real instances (plus the app's own real `db`/
 * `EventStoreService`/`ProjectionRunner`) — never a mock. `CommandsService`
 * itself is still NOT part of `AppModule` (PR6 wires the controller), so it is
 * dynamically imported and constructed directly, same "real error, not a
 * mock" RED-state reasoning as PR4's own file.
 *
 * RED STATE (expected, today): `./commands.service.ts`'s `CommandsService`
 * has no `decide()` method and its constructor does not yet accept
 * `objectsService`/`relationsService`/`workspaceMembershipService` — every
 * test below is expected to fail until `implementer` extends it to match this
 * file's pinned contract exactly (see the task's "Settled design" section,
 * reproduced in the local types below).
 *
 * ============================================================================
 * DESIGN NOTES specific to this file (test-writer judgment calls, documented
 * per CLAUDE.md's TDD ritual):
 *
 * - `generateSubtasks` PARTIAL FAILURE (AC6): there is no natural real-world
 *   constraint a `subtaskTitles` entry can violate to force a REAL mid-loop
 *   failure (every subtask id/title here is freshly minted and unique, so
 *   nothing collides). Per the task's own "use your judgment" allowance, this
 *   test installs a `vi.spyOn(objectsService, 'create')` that forwards to the
 *   REAL implementation on every call except the 2nd (which throws a plain
 *   `Error`) — scoped tightly (installed immediately before, restored
 *   immediately after, that one `decide()` call) since `objectsService` is a
 *   single shared instance reused across this whole file's tests.
 *
 * - `proposedActionSchema` (spec step 4, the defensive re-validation of
 *   `command_proposals.actions` at READ time): this test-writer subagent's
 *   hard boundary restricts it to `*.test.ts`/`*.spec.ts` files only (a
 *   `PreToolUse` hook enforces this). `../ai/parse-command.ts`'s
 *   `proposedActionSchema` was therefore NOT exported by this pass — that
 *   decision (export-and-reuse vs. a local equivalent schema inside
 *   `decide()`) is left entirely to `implementer`. AC11 below pins the
 *   OBSERVABLE BEHAVIOR step 4 requires (a structurally malformed action in
 *   the `actions` jsonb column fails independently, without crashing the
 *   whole `decide()` call), which is schema-implementation-agnostic.
 *
 * - AC11 forces the "don't trust `command_proposals.actions` at read time"
 *   scenario via a raw SQL `UPDATE` of the jsonb column AFTER `parse()` has
 *   already durably written it — standing in for any real-world drift (a
 *   manual DB edit, a future migration bug, a bypassed write path) that could
 *   otherwise let an unvalidated `type` reach `decide()`'s dispatch switch.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';
const RETURN_MARKER = 'RETURN:';

/** ADR-0015 §d's fixed `ActionsProposed` actor — `decide()`'s own
 * `ActionsDecided` event, and every resulting mutation event, must NEVER
 * carry this actor; they must always carry the REAL approving user's own
 * actor instead. */
const COMMAND_PARSER_ACTOR: Actor = { type: 'agent', id: 'command-parser' };

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
 * extends it — declared locally (not statically imported) since the module
 * doesn't exist with this shape yet; see this file's header for the dynamic
 * `import()` this backs. */
interface CommandsServiceContract {
  parse(
    workspaceId: string,
    actor: Actor,
    command: string,
    sourceObjectId?: string,
  ): Promise<CommandsServiceParseResult>;
  decide(
    workspaceId: string,
    proposalId: string,
    approverActor: Actor,
    callerRole: Role,
    decisions: DecisionInput[],
  ): Promise<{ results: DecideActionResult[] }>;
}

/** The task's "Settled design" constructor shape: the ORIGINAL 5 deps
 * (`db`/`eventStore`/`projectionRunner`/`aiUsageService`/`aiProvider`),
 * PLUS the 3 new ones (`objectsService`/`relationsService`/
 * `workspaceMembershipService`), in that exact order. */
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

interface RawCommandProposalRow {
  id: string;
  stream_id: string;
  actions: unknown;
  decided_at: Date | null;
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
  return `commands-decide-test-user-${String(emailCounter)}@example.com`;
}

describe('CommandsService.decide() (F1-T16 PR5, real Postgres + real Redis via Testcontainers)', () => {
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

    // Deliberately NOT set -- forces the AI_PROVIDER DI wiring to fall back
    // to MockProvider (`unconfiguredResponder`'s `RETURN:` marker
    // convention), same as every other integration test file here.
    delete process.env.ANTHROPIC_API_KEY;
    // Generous, non-blocking quota/budget -- this file's tests are never
    // ABOUT quota enforcement (that is PR4's own concern); every `parse()`
    // call below happens in its own freshly-registered workspace anyway (0
    // prior usage), but a generous value removes any doubt.
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '1000000';
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '1000000';

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the
    // established convention in every other integration test file here.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;

    db = app.get<Database>(DATABASE_CONNECTION);
    eventStore = app.get(EventStoreService);
    projectionRunner = app.get(ProjectionRunner);
    aiProvider = app.get<AIProvider>(AI_PROVIDER);

    // `ObjectsService`/`RelationsService`/`WorkspaceMembershipService`/
    // `AIUsageService` each transitively import `../config/env.js` (an
    // eagerly-evaluated singleton) -- dynamically imported here, AFTER the
    // env vars above are set and AFTER `../app.module.js` has already been
    // imported once (above), mirroring
    // `./commands.service.integration.test.ts`'s own established reasoning
    // for `AIUsageService`. These are Node module-cache HITS by this point,
    // not fresh evaluations -- only pulled in dynamically (rather than
    // imported as static VALUES at this file's top) to avoid any doubt about
    // import-order safety. Only their TYPES are imported statically above
    // (`import type`, erased at compile time -- zero runtime import).
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

    // Deliberately unresolvable until `implementer` extends
    // `./commands.service.ts` with `decide()` (and the 3 new constructor
    // params) -- see this file's header. The eslint-disable below only
    // silences the STATIC-ANALYSIS finding for this one line; the dynamic
    // `import()` still throws a real "Cannot find module" error at
    // test-run time today (there is no `decide` export gap yet -- the whole
    // FILE'S construction below fails, which is the correct RED failure
    // reason for every test in this file simultaneously).

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

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
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
    const workspaceId = await createWorkspace(cookie, `Decide Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId, ownerUserId: userId };
  }

  /** Mirrors `../fields/field-definitions-security.integration.test.ts`'s own
   * `addMemberWithRole` raw-DB pattern -- there is no HTTP invite endpoint,
   * so a real non-owner membership row is fabricated directly. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await db.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
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

  /** Same `RETURN:<text>` marker convention as
   * `./commands.service.integration.test.ts` / `../ai/ai-provider.module.ts`'s
   * `unconfiguredResponder`. */
  function scriptedActionsCommand(actions: Record<string, unknown>[]): string {
    return `Please act on this. ${RETURN_MARKER}${JSON.stringify(actions)}`;
  }

  function createTaskAction(title: string): Record<string, unknown> {
    return {
      type: 'createTask',
      intent: 'Create a follow-up task',
      rationale: 'The user asked for one',
      resources: [],
      rollbackNote: 'Delete the created task',
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

  /** `parse()` a scripted command and assert it succeeded -- the shared
   * proposal-setup step every test below needs before it can call
   * `decide()`. */
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

  async function getProposalRow(proposalId: string): Promise<RawCommandProposalRow | undefined> {
    const result = await db.$client.query<RawCommandProposalRow>(
      'select id, stream_id, actions, decided_at from command_proposals where id = $1',
      [proposalId],
    );
    return result.rows[0];
  }

  async function readProposalStreamEvents(proposalId: string) {
    const row = await getProposalRow(proposalId);
    if (!row) {
      throw new Error('Test bug: expected a command_proposals row to exist');
    }
    return eventStore.readStream(row.stream_id);
  }

  async function readObjectStreamEvents(objectId: string) {
    const [row] = await db
      .select({ streamId: objectsView.streamId })
      .from(objectsView)
      .where(eq(objectsView.id, objectId))
      .limit(1);
    if (!row) {
      throw new Error('Test bug: expected an objects_view row to exist');
    }
    return eventStore.readStream(row.streamId);
  }

  async function readRelationStreamEvents(relationId: string) {
    const [row] = await db
      .select({ streamId: relationsView.streamId })
      .from(relationsView)
      .where(eq(relationsView.id, relationId))
      .limit(1);
    if (!row) {
      throw new Error('Test bug: expected a relations_view row to exist');
    }
    return eventStore.readStream(row.streamId);
  }

  async function countObjectsWithTitle(workspaceId: string, title: string): Promise<number> {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    return objects.filter((object) => object.title === title).length;
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
  // AC0 -- missing proposal
  // ---------------------------------------------------------------------

  describe('AC0: a proposalId that does not exist', () => {
    it('throws NotFoundError', async () => {
      const approverActor: Actor = { type: 'user', id: randomUUID() };

      await expect(
        service.decide(randomUUID(), randomUUID(), approverActor, 'owner', []),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ---------------------------------------------------------------------
  // AC1 -- createTask happy path
  // ---------------------------------------------------------------------

  describe('AC1: createTask happy path', () => {
    it('an approved createTask executes, creates a real task, and attributes ObjectCreated to the approving user (not command-parser)', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'AC1 Follow-up task';

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

      const createdObject = await findObjectByTitle(workspaceId, title);
      expect(createdObject.type).toBe('task');

      const objectEvents = await readObjectStreamEvents(createdObject.id);
      const createdEvent = objectEvents.find((event) => event.type === 'ObjectCreated');
      expect(createdEvent).toBeDefined();
      expect(createdEvent?.actor).toEqual(approverActor);
      expect(createdEvent?.actor).not.toEqual(COMMAND_PARSER_ACTOR);
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- createTask rejection
  // ---------------------------------------------------------------------

  describe('AC2: createTask rejection', () => {
    it('a rejected createTask never executes: status "rejected", no object created', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'AC2 Should never exist';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(title),
      ]);
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
  // AC3 -- already-decided guard (the entire idempotency mechanism)
  // ---------------------------------------------------------------------

  describe('AC3: already-decided guard', () => {
    it('a second decide() call for the same proposalId throws ConflictError and does not re-execute', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'AC3 Only once';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(title),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }
      const decisions: DecisionInput[] = [{ actionId, decision: 'approved' }];

      const first = await service.decide(
        workspaceId,
        proposalId,
        approverActor,
        'owner',
        decisions,
      );
      expect(first.results).toEqual([{ actionId, status: 'executed' }]);
      expect(await countObjectsWithTitle(workspaceId, title)).toBe(1);

      await expect(
        service.decide(workspaceId, proposalId, approverActor, 'owner', decisions),
      ).rejects.toBeInstanceOf(ConflictError);

      // The whole point of this guard: a second call must NEVER re-execute,
      // not even partially -- exactly one task, never two.
      expect(await countObjectsWithTitle(workspaceId, title)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- unknown actionId in decisions
  // ---------------------------------------------------------------------

  describe('AC4: an unknown actionId in decisions', () => {
    it('throws ValidationError before any execution and before ActionsDecided is appended', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'AC4 Should never exist';

      const { proposalId } = await parseAndGetActions(workspaceId, [createTaskAction(title)]);
      const bogusActionId = randomUUID();

      await expect(
        service.decide(workspaceId, proposalId, approverActor, 'owner', [
          { actionId: bogusActionId, decision: 'approved' },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countObjectsWithTitle(workspaceId, title)).toBe(0);

      const row = await getProposalRow(proposalId);
      expect(row?.decided_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- generateSubtasks full success
  // ---------------------------------------------------------------------

  describe('AC5: generateSubtasks full success', () => {
    it('creates every subtask + parentChild relation, all attributed to the approving user, and omits createdCount/totalCount/failedAtStep on full success', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const parent = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'AC5 Parent task' },
        'owner',
      );

      const subtaskTitles = ['AC5 Subtask 1', 'AC5 Subtask 2', 'AC5 Subtask 3'];
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

      // Full success omits createdCount/totalCount/failedAtStep entirely
      // (per the pinned interface) -- `toEqual` on the exact object shape
      // below would fail if the implementation left any of them present.
      expect(results).toEqual([{ actionId, status: 'executed' }]);

      const related = await relationsService.getRelated(workspaceId, parent.id);
      expect(related.parentChild.children).toHaveLength(3);

      const childTitles = new Set<string>();
      for (const child of related.parentChild.children) {
        const childObject = await objectsService.get(workspaceId, child.toId, 'owner');
        childTitles.add(childObject.title);
      }
      expect(childTitles).toEqual(new Set(subtaskTitles));

      // One representative subtask + its own relation, actor-checked -- a
      // DISTINCT code path from AC1's createTask (objectsService.create +
      // relationsService.create together), per this PR's crux security
      // property (ADR-0015 §d).
      const [firstChild] = related.parentChild.children;
      if (!firstChild) {
        throw new Error('Test bug: expected at least one created subtask relation');
      }

      const childObjectEvents = await readObjectStreamEvents(firstChild.toId);
      const childCreatedEvent = childObjectEvents.find((event) => event.type === 'ObjectCreated');
      expect(childCreatedEvent?.actor).toEqual(approverActor);
      expect(childCreatedEvent?.actor).not.toEqual(COMMAND_PARSER_ACTOR);

      const relationEvents = await readRelationStreamEvents(firstChild.id);
      const relationCreatedEvent = relationEvents.find((event) => event.type === 'RelationCreated');
      expect(relationCreatedEvent?.actor).toEqual(approverActor);
      expect(relationCreatedEvent?.actor).not.toEqual(COMMAND_PARSER_ACTOR);
    });
  });

  // ---------------------------------------------------------------------
  // AC6 -- generateSubtasks partial failure (stops at the failing step)
  // ---------------------------------------------------------------------

  describe('AC6: generateSubtasks partial failure', () => {
    it('stops at the failing step and reports partially_executed with accurate createdCount/totalCount/failedAtStep', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };

      const parent = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'AC6 Parent task' },
        'owner',
      );

      const subtaskTitles = ['AC6 Subtask 1', 'AC6 Subtask 2', 'AC6 Subtask 3'];
      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        generateSubtasksAction(parent.id, subtaskTitles),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      // Forces the 2nd subtask's own `objectsService.create` call to fail --
      // the most realistic deterministic way to force a MID-LOOP failure
      // against REAL services: no natural real-world constraint exists here
      // (every subtask title/id is freshly minted and unique). Scoped
      // strictly to this one `decide()` call: installed immediately before,
      // restored immediately after -- `objectsService` is a single shared
      // instance reused across this whole file's tests.
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

      try {
        const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
          { actionId, decision: 'approved' },
        ]);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          actionId,
          status: 'partially_executed',
          createdCount: 1,
          totalCount: 3,
          failedAtStep: 2,
        });
        expect(typeof results[0]?.error).toBe('string');
      } finally {
        createSpy.mockRestore();
      }

      const related = await relationsService.getRelated(workspaceId, parent.id);
      expect(related.parentChild.children).toHaveLength(1);

      const [survivingChild] = related.parentChild.children;
      if (!survivingChild) {
        throw new Error('Test bug: expected exactly one surviving subtask relation');
      }
      const survivingChildObject = await objectsService.get(
        workspaceId,
        survivingChild.toId,
        'owner',
      );
      expect(survivingChildObject.title).toBe('AC6 Subtask 1');
    });
  });

  // ---------------------------------------------------------------------
  // AC7 -- assignPeople happy path
  // ---------------------------------------------------------------------

  describe('AC7: assignPeople happy path', () => {
    it('sets the field value when every target userId really is a workspace member', async () => {
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
        { objectType: 'task', title: 'AC7 Target task' },
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

      const updated = await objectsService.get(workspaceId, target.id, 'owner');
      expect(updated.fieldValues.assignees).toEqual([memberUserId]);
    });
  });

  // ---------------------------------------------------------------------
  // AC8 -- assignPeople with a non-member target
  // ---------------------------------------------------------------------

  describe('AC8: assignPeople with a non-member target', () => {
    it('reports failed (caught, not thrown) and never writes the field value', async () => {
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
        { objectType: 'task', title: 'AC8 Target task' },
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
      expect(typeof results[0]?.error).toBe('string');

      const updated = await objectsService.get(workspaceId, target.id, 'owner');
      expect(updated.fieldValues.assignees).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC9 -- multiple actions in one decide() call, mixed outcomes
  // ---------------------------------------------------------------------

  describe('AC9: multiple actions in one decide() call, mixed outcomes', () => {
    it('returns one result per input decision, in input order, each independently correct -- one failure never aborts or affects the others', async () => {
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

      const assignTarget = await objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title: 'AC9 Assign target' },
        'owner',
      );

      const succeedTitle = 'AC9 Should be created';
      const rejectedTitle = 'AC9 Should never be created (rejected)';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(succeedTitle),
        assignPeopleAction(assignTarget.id, 'assignees', [nonMemberUserId]),
        createTaskAction(rejectedTitle),
      ]);

      const [createAction, assignAction, rejectedAction] = actions;
      if (!createAction || !assignAction || !rejectedAction) {
        throw new Error('Test bug: expected exactly 3 parsed actions');
      }

      const decisions: DecisionInput[] = [
        { actionId: createAction.actionId, decision: 'approved' },
        { actionId: assignAction.actionId, decision: 'approved' },
        { actionId: rejectedAction.actionId, decision: 'rejected' },
      ];

      const { results } = await service.decide(
        workspaceId,
        proposalId,
        approverActor,
        'owner',
        decisions,
      );

      expect(results).toHaveLength(3);
      expect(results.map((result) => result.actionId)).toEqual(
        decisions.map((decision) => decision.actionId),
      );
      expect(results[0]).toEqual({ actionId: createAction.actionId, status: 'executed' });
      expect(results[1]).toMatchObject({ actionId: assignAction.actionId, status: 'failed' });
      expect(typeof results[1]?.error).toBe('string');
      expect(results[2]).toEqual({ actionId: rejectedAction.actionId, status: 'rejected' });

      expect(await countObjectsWithTitle(workspaceId, succeedTitle)).toBe(1);
      expect(await countObjectsWithTitle(workspaceId, rejectedTitle)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC10 -- ActionsDecided's own actor (ADR-0015 §d)
  // ---------------------------------------------------------------------

  describe('AC10: the raw ActionsDecided event is authored by the approving user, never command-parser', () => {
    it('reading the raw event back from the proposal stream shows the real approving-user actor, at version 2', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const title = 'AC10 Task';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(title),
      ]);
      const actionId = actions[0]?.actionId;
      if (actionId === undefined) {
        throw new Error('Test bug: expected exactly one parsed action');
      }

      await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId, decision: 'approved' },
      ]);

      const streamEvents = await readProposalStreamEvents(proposalId);
      const decidedEvent = streamEvents.find((event) => event.type === 'ActionsDecided');

      expect(decidedEvent).toBeDefined();
      expect(decidedEvent?.actor).toEqual(approverActor);
      expect(decidedEvent?.actor).not.toEqual(COMMAND_PARSER_ACTOR);
      expect(decidedEvent?.version).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // AC11 -- defensive re-validation of command_proposals.actions at READ
  // time (spec step 4, a PR4 security-review finding)
  // ---------------------------------------------------------------------

  describe('AC11: a structurally malformed action in the actions jsonb column fails independently, without crashing the whole call', () => {
    it('does not blindly trust command_proposals.actions at read time -- a corrupted "type" fails only that one action', async () => {
      const { workspaceId, ownerUserId } = await registerOwnerWithWorkspace();
      const approverActor: Actor = { type: 'user', id: ownerUserId };
      const validTitle = 'AC11 Valid action still runs';

      const { proposalId, actions } = await parseAndGetActions(workspaceId, [
        createTaskAction(validTitle),
        createTaskAction('AC11 About to be corrupted'),
      ]);
      const [validAction, toCorrupt] = actions;
      if (!validAction || !toCorrupt) {
        throw new Error('Test bug: expected exactly 2 parsed actions');
      }

      // Simulates the exact security-review finding step 4 of this PR's spec
      // pins: `command_proposals.actions` has NO structural validation at the
      // projection layer, only at `parseCommand`'s WRITE-time zod check --
      // `decide()` must re-validate at READ time, not blindly trust this
      // column's stored shape. A raw UPDATE bypasses the write-time check
      // entirely, standing in for any real-world drift (a manual DB edit, a
      // future migration bug, a bypassed write path) that could otherwise let
      // an arbitrary "type" reach the dispatch switch unvalidated.
      const corruptedActions: Record<string, unknown>[] = actions.map((action) =>
        action.actionId === toCorrupt.actionId
          ? { ...action, type: 'wipeDatabase' }
          : { ...action },
      );
      await db.$client.query('update command_proposals set actions = $1::jsonb where id = $2', [
        JSON.stringify(corruptedActions),
        proposalId,
      ]);

      const { results } = await service.decide(workspaceId, proposalId, approverActor, 'owner', [
        { actionId: validAction.actionId, decision: 'approved' },
        { actionId: toCorrupt.actionId, decision: 'approved' },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ actionId: validAction.actionId, status: 'executed' });
      expect(results[1]).toMatchObject({ actionId: toCorrupt.actionId, status: 'failed' });
      expect(typeof results[1]?.error).toBe('string');

      expect(await countObjectsWithTitle(workspaceId, validTitle)).toBe(1);
    });
  });
});
