import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { objectResource } from '@luminaos/agent-runtime';
import type { AgentActionRecord, RollbackPlan } from '@luminaos/agent-runtime';
import type { AIProvider } from '@luminaos/ai-gateway';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@luminaos/shared';
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

import type { RecordAgentActionInput } from '../agent-runtime/agent-action-records.service.js';
import type { AIUsageService } from '../ai/ai-usage.service.js';
import type { Database } from '../db/client.js';
import type { ObjectsService } from '../objects/objects.service.js';
import type { RelationsService } from '../relations/relations.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T6 PR2 (RED step), ADR-0040 Karar (d)/(e)/(f) — `CommandsService.undoAction`,
 * the real execution of a one-click undo for `rollbackPlan.kind === 'delete'`
 * ledger records. `AgentActionRecordsService.findUndoRecord`/
 * `AgentActionRecord.undoesRecordId` (PR1) are ALREADY MERGED and used here as
 * real, unmocked collaborators.
 *
 * Reuses `./commands.service.ledger.integration.test.ts` / `./commands.service.
 * autonomy-dial.integration.test.ts`'s exact FULL-`AppModule` harness (real
 * Postgres 16 + Redis 7 via Testcontainers, `Test.createTestingModule({imports:
 * [AppModule]})`, real collaborator services pulled out of that container via
 * `app.get(...)`, `CommandsService` itself manually `new`'d with those real
 * instances) — booting the full `AppModule` here also means a real
 * `CommandsModule <-> AgentRuntimeModule` circular-import mistake (this PR's
 * own module-wiring risk per ADR-0040 Karar g, needing `forwardRef()` on BOTH
 * sides) fails this file's `beforeAll` immediately and loudly, rather than
 * silently — a wiring failure here fails EVERY test in this file at
 * `beforeAll`, not just the `undoAction`-specific assertions below.
 *
 * Lightweight fixture workspaces (direct `db.insert(workspaces)`, no HTTP user
 * registration) — mirrors `./commands.service.autonomy-dial.integration.test.ts`'s
 * own precedent: `undoAction`'s RBAC gate is purely the `callerRole` string
 * argument (delegated to `AgentActionRecordsService.get()`'s own `member`+
 * check), never a real DB-backed membership row, so no HTTP session/
 * registration/membership insert is needed anywhere in this file.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `CommandsService` has NO `undoAction` method at
 * all — `service.undoAction(...)` throws `TypeError: service.undoAction is not
 * a function` for every `it` below. This is the correct RED failure mode, not
 * a bug in this test file.
 * ============================================================================
 */

interface CommandsServiceContract {
  undoAction(
    workspaceId: string,
    recordId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<{ status: 'undone' }>;
}

/** Pinned by ADR-0040 Karar d: NO constructor change from the current, already
 * merged 12-arg shape (`AgentActionRecordsService`/`ObjectsService` are ALREADY
 * injected today) — `undoAction` is purely a new method on the existing class. */
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

describe('CommandsService.undoAction (F3-T6 PR2, ADR-0040 Karar d/e/f, real Postgres + real Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;
  let objectsService: ObjectsService;
  let agentActionRecordsService: AgentActionRecordsService;
  let service: CommandsServiceContract;
  let workspaceCounter = 0;

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
    const eventStore = app.get(EventStoreService);
    const projectionRunner = app.get(ProjectionRunner);
    const aiProvider = app.get<AIProvider>(AI_PROVIDER);

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (objectsServiceModule as { ObjectsService: Type<ObjectsService> })
      .ObjectsService;
    objectsService = app.get<ObjectsService>(ObjectsServiceCtor);

    const relationsServiceModule: unknown = await import('../relations/relations.service.js');
    const RelationsServiceCtor = (
      relationsServiceModule as { RelationsService: Type<RelationsService> }
    ).RelationsService;
    const relationsService = app.get<RelationsService>(RelationsServiceCtor);

    const workspaceMembershipServiceModule: unknown =
      await import('../workspaces/workspace-membership.service.js');
    const WorkspaceMembershipServiceCtor = (
      workspaceMembershipServiceModule as {
        WorkspaceMembershipService: Type<WorkspaceMembershipService>;
      }
    ).WorkspaceMembershipService;
    const workspaceMembershipService = app.get<WorkspaceMembershipService>(
      WorkspaceMembershipServiceCtor,
    );

    const aiUsageServiceModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageServiceModule as { AIUsageService: Type<AIUsageService> })
      .AIUsageService;
    const aiUsageService = app.get<AIUsageService>(AIUsageServiceCtor);

    const agentPermissionManifestsService = app.get(AgentPermissionManifestsService);
    agentActionRecordsService = app.get(AgentActionRecordsService);
    const autonomyTierSettingsService = app.get(AutonomyTierSettingsService);
    const commentsService = app.get(CommentsService);

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

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `undo-action-test-workspace-${String(workspaceCounter)}`,
        slug: `undo-action-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Test bug: failed to create test workspace');
    }
    return row.id;
  }

  function fakeActor(): Actor {
    return { type: 'user', id: randomUUID() };
  }

  async function createTask(workspaceId: string, actor: Actor, title: string): Promise<string> {
    const created = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title },
      'owner',
    );
    return created.id;
  }

  function uniqueIntent(label: string): string {
    return `${label} ${randomUUID()}`;
  }

  async function seedRecord(
    workspaceId: string,
    input: RecordAgentActionInput,
  ): Promise<AgentActionRecord> {
    await agentActionRecordsService.record(workspaceId, input);
    const rows = await agentActionRecordsService.list(workspaceId, 'owner');
    const match = rows.find((row) => row.intent === input.intent);
    if (!match) {
      throw new Error(`Test bug: expected a seeded record with intent "${input.intent}"`);
    }
    return match;
  }

  function deleteKindInput(
    overrides: Partial<RecordAgentActionInput> = {},
  ): RecordAgentActionInput {
    return {
      provenance: 'decided',
      actor: fakeActor(),
      actionType: 'createTask',
      intent: uniqueIntent('undoAction test createTask'),
      rationale: 'The user asked for one.',
      resources: [],
      rollbackPlan: { kind: 'delete', description: 'Oluşturulan görevi sil.' },
      outcome: 'succeeded',
      resultRef: null,
      causationEventId: randomUUID(),
      undoesRecordId: null,
      ...overrides,
    };
  }

  async function getObjectLifecycle(
    workspaceId: string,
    objectId: string,
  ): Promise<'active' | 'archived' | 'deleted'> {
    const object = await objectsService.get(workspaceId, objectId, 'owner');
    return object.lifecycle;
  }

  // =========================================================================
  // 1. Single-object kind:'delete' action
  // =========================================================================

  describe('1. undoing a single-object kind:"delete" action (createTask-shaped)', () => {
    it('soft-deletes the object, returns {status:"undone"}, writes a well-formed second ledger record, and never mutates the original row', async () => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();
      const taskId = await createTask(workspaceId, approverActor, 'Undo single-object task');

      const original = await seedRecord(
        workspaceId,
        deleteKindInput({
          actor: approverActor,
          resources: [objectResource(taskId)],
          rollbackPlan: {
            kind: 'delete',
            targetResource: objectResource(taskId),
            description: 'Oluşturulan görevi sil.',
          },
          resultRef: objectResource(taskId),
        }),
      );

      const result = await service.undoAction(workspaceId, original.id, approverActor, 'owner');
      expect(result).toEqual({ status: 'undone' });

      expect(await getObjectLifecycle(workspaceId, taskId)).toBe('deleted');

      const undoRecord = await agentActionRecordsService.findUndoRecord(workspaceId, original.id);
      expect(undoRecord).not.toBeNull();
      expect(undoRecord?.actionType).toBe('undoAction');
      expect(undoRecord?.provenance).toBe('decided');
      expect(undoRecord?.causationEventId).toBeNull();
      expect(undoRecord?.undoesRecordId).toBe(original.id);
      expect(undoRecord?.intent).toBe(`"${original.actionType}" aksiyonunu geri al.`);
      expect(undoRecord?.rationale).toBe(
        'Kullanıcı Uçuş Kayıt Cihazı panelinden bu aksiyonu geri aldı.',
      );
      expect(undoRecord?.resources).toEqual(original.resources);
      expect(undoRecord?.rollbackPlan).toEqual<RollbackPlan>({
        kind: 'none',
        description: 'Bir geri alma aksiyonu kendisi geri alınamaz.',
      });
      expect(undoRecord?.outcome).toBe('succeeded');
      expect(undoRecord?.resultRef).toBeNull();

      const reFetchedOriginal = await agentActionRecordsService.get(
        workspaceId,
        original.id,
        'owner',
      );
      expect(reFetchedOriginal).toEqual(original);
    });
  });

  // =========================================================================
  // 2. Multi-object generateSubtasks-shaped action (no targetResource)
  // =========================================================================

  describe('2. undoing a multi-object kind:"delete" action with NO rollbackPlan.targetResource (generateSubtasks-shaped)', () => {
    it('soft-deletes every id in resources[] — proving undoAction reads resources[], never rollbackPlan.targetResource', async () => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();
      const subtask1Id = await createTask(
        workspaceId,
        approverActor,
        'Undo multi-object subtask 1',
      );
      const subtask2Id = await createTask(
        workspaceId,
        approverActor,
        'Undo multi-object subtask 2',
      );

      const original = await seedRecord(
        workspaceId,
        deleteKindInput({
          actor: approverActor,
          actionType: 'generateSubtasks',
          resources: [objectResource(subtask1Id), objectResource(subtask2Id)],
          rollbackPlan: {
            kind: 'delete',
            description: 'Oluşturulan alt görevleri sil.',
          },
          resultRef: null,
        }),
      );
      // Sanity: this fixture really has NO targetResource, matching the real
      // executeGenerateSubtasks shape.
      expect(original.rollbackPlan.targetResource).toBeUndefined();

      const result = await service.undoAction(workspaceId, original.id, approverActor, 'owner');
      expect(result).toEqual({ status: 'undone' });

      expect(await getObjectLifecycle(workspaceId, subtask1Id)).toBe('deleted');
      expect(await getObjectLifecycle(workspaceId, subtask2Id)).toBe('deleted');
    });

    it('a mid-loop failure (one target already soft-deleted by an unrelated action) still writes a partial-outcome undo ledger entry, and a retry rejects with ConflictError instead of re-throwing forever (security-review finding)', async () => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();
      const subtask1Id = await createTask(
        workspaceId,
        approverActor,
        'Undo partial-failure subtask 1',
      );
      const subtask2Id = await createTask(
        workspaceId,
        approverActor,
        'Undo partial-failure subtask 2',
      );

      const original = await seedRecord(
        workspaceId,
        deleteKindInput({
          actor: approverActor,
          actionType: 'generateSubtasks',
          resources: [objectResource(subtask1Id), objectResource(subtask2Id)],
          rollbackPlan: {
            kind: 'delete',
            description: 'Oluşturulan alt görevleri sil.',
          },
          resultRef: null,
        }),
      );

      // Simulates an unrelated, later direct deletion of subtask1 -- when
      // undoAction later iterates resources[] in order, softDelete on
      // subtask1 will throw (already 'deleted'), subtask2 must still be
      // deleted first per the seeded order below... instead we delete the
      // FIRST resource so the loop fails on the very first target, proving
      // the 'failed' (zero successes) branch, not just 'partially_succeeded'.
      await objectsService.softDelete(workspaceId, subtask1Id, approverActor);

      await expect(
        service.undoAction(workspaceId, original.id, approverActor, 'owner'),
      ).rejects.toThrow();

      // subtask2 was never reached (loop broke on subtask1's failure) --
      // still active, not silently deleted without a ledger trace.
      expect(await getObjectLifecycle(workspaceId, subtask2Id)).toBe('active');

      const undoRecord = await agentActionRecordsService.findUndoRecord(workspaceId, original.id);
      expect(undoRecord).not.toBeNull();
      expect(undoRecord?.outcome).toBe('failed');
      expect(undoRecord?.undoesRecordId).toBe(original.id);

      // Retrying no longer re-attempts the same already-deleted target --
      // it fails closed via the now-existing undo ledger entry.
      await expect(
        service.undoAction(workspaceId, original.id, approverActor, 'owner'),
      ).rejects.toThrow(ConflictError);
    });
  });

  // =========================================================================
  // 3. rollbackPlan.kind !== 'delete' -> ValidationError, no mutation
  // =========================================================================

  describe('3. a record whose rollbackPlan.kind is not "delete" cannot be undone automatically', () => {
    it.each<RollbackPlan['kind']>(['revertFieldValue', 'revokePermission', 'manual', 'none'])(
      'kind:"%s" rejects with ValidationError, performs no mutation, and writes no ledger record',
      async (kind) => {
        const workspaceId = await createWorkspace();
        const approverActor = fakeActor();
        const taskId = await createTask(workspaceId, approverActor, `Undo non-delete kind ${kind}`);

        const original = await seedRecord(
          workspaceId,
          deleteKindInput({
            actor: approverActor,
            actionType: 'assignPeople',
            resources: [objectResource(taskId)],
            rollbackPlan: { kind, description: `Non-delete rollback plan (${kind}).` },
            resultRef: objectResource(taskId),
          }),
        );

        await expect(
          service.undoAction(workspaceId, original.id, approverActor, 'owner'),
        ).rejects.toThrow(ValidationError);

        expect(await getObjectLifecycle(workspaceId, taskId)).toBe('active');
        const undoRecord = await agentActionRecordsService.findUndoRecord(workspaceId, original.id);
        expect(undoRecord).toBeNull();
      },
    );
  });

  // =========================================================================
  // 4. Already-undone -> ConflictError
  // =========================================================================

  describe('4. a second undoAction call on an already-undone record is rejected', () => {
    it('the first call succeeds, the second call on the SAME recordId rejects with ConflictError, and only ONE undo record ever exists', async () => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();
      const taskId = await createTask(workspaceId, approverActor, 'Undo double-undo task');

      const original = await seedRecord(
        workspaceId,
        deleteKindInput({
          actor: approverActor,
          resources: [objectResource(taskId)],
          rollbackPlan: {
            kind: 'delete',
            targetResource: objectResource(taskId),
            description: 'Oluşturulan görevi sil.',
          },
          resultRef: objectResource(taskId),
        }),
      );

      await expect(
        service.undoAction(workspaceId, original.id, approverActor, 'owner'),
      ).resolves.toEqual({ status: 'undone' });

      await expect(
        service.undoAction(workspaceId, original.id, approverActor, 'owner'),
      ).rejects.toThrow(ConflictError);

      const rows = await agentActionRecordsService.list(workspaceId, 'owner');
      const undoRows = rows.filter((row) => row.undoesRecordId === original.id);
      expect(undoRows).toHaveLength(1);
    });
  });

  // =========================================================================
  // 5. Non-existent recordId -> NotFoundError
  // =========================================================================

  describe('5. a non-existent recordId', () => {
    it('rejects with NotFoundError', async () => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();

      await expect(
        service.undoAction(workspaceId, randomUUID(), approverActor, 'owner'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // =========================================================================
  // 6. recordId belonging to a DIFFERENT workspace -> NotFoundError
  // =========================================================================

  describe('6. a recordId that belongs to a DIFFERENT workspace', () => {
    it('rejects with NotFoundError (not a data leak / distinguishable error)', async () => {
      const workspaceIdA = await createWorkspace();
      const workspaceIdB = await createWorkspace();
      const approverActor = fakeActor();
      const taskId = await createTask(workspaceIdA, approverActor, 'Undo cross-workspace task');

      const original = await seedRecord(
        workspaceIdA,
        deleteKindInput({
          actor: approverActor,
          resources: [objectResource(taskId)],
          rollbackPlan: {
            kind: 'delete',
            targetResource: objectResource(taskId),
            description: 'Oluşturulan görevi sil.',
          },
          resultRef: objectResource(taskId),
        }),
      );

      await expect(
        service.undoAction(workspaceIdB, original.id, approverActor, 'owner'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // =========================================================================
  // 7. RBAC — member+ required, mirrors AgentActionRecordsService.get()'s own gate
  // =========================================================================

  describe('7. RBAC: member+ required (delegated to AgentActionRecordsService.get())', () => {
    it('"guest" is rejected with ForbiddenError', async () => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();
      const taskId = await createTask(workspaceId, approverActor, 'Undo RBAC guest task');

      const original = await seedRecord(
        workspaceId,
        deleteKindInput({
          actor: approverActor,
          resources: [objectResource(taskId)],
          rollbackPlan: {
            kind: 'delete',
            targetResource: objectResource(taskId),
            description: 'Oluşturulan görevi sil.',
          },
          resultRef: objectResource(taskId),
        }),
      );

      await expect(
        service.undoAction(workspaceId, original.id, approverActor, 'guest'),
      ).rejects.toThrow(ForbiddenError);
    });

    it.each<MembershipRole>(['member', 'admin', 'owner'])('"%s" succeeds', async (callerRole) => {
      const workspaceId = await createWorkspace();
      const approverActor = fakeActor();
      const taskId = await createTask(workspaceId, approverActor, `Undo RBAC ${callerRole} task`);

      const original = await seedRecord(
        workspaceId,
        deleteKindInput({
          actor: approverActor,
          resources: [objectResource(taskId)],
          rollbackPlan: {
            kind: 'delete',
            targetResource: objectResource(taskId),
            description: 'Oluşturulan görevi sil.',
          },
          resultRef: objectResource(taskId),
        }),
      );

      await expect(
        service.undoAction(workspaceId, original.id, approverActor, callerRole),
      ).resolves.toEqual({ status: 'undone' });
    });
  });
});
