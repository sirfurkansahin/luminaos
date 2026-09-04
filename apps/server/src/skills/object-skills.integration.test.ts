import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';
import type { Skill, SkillRegistry } from '@luminaos/skill-sdk';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T2 PR3 (RED step), ADR-0036 — `apps/server/src/skills/object-skills.ts`:
 * the first 9 REAL, first-party skills (catalog #1-9, spec's table), each a
 * thin wrapper around one `ObjectsService` method.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./object-skills.ts` does not exist at all, so
 * the dynamic `import('./object-skills.js')` call inside `beforeAll` REJECTS
 * ("Cannot find module"), failing every `it` in this file -- mirrors
 * `skill-execution.service.integration.test.ts`'s own documented "module
 * doesn't exist yet" red state. `./skill-execution.service.ts`,
 * `../objects/objects.service.ts`, and `../agent-runtime/agent-permission-
 * manifests.service.ts` all already exist (merged) -- this file dynamically
 * imports them too, ONLY to control exactly when they (and their transitive
 * `../config/env.js` dependency, e.g. via `AgentResourceLimitsService`/
 * `AIUsageService`) are evaluated relative to this file's own
 * `process.env.DATABASE_URL`/`REDIS_URL` assignment in `beforeAll` -- NOT
 * because they are themselves missing.
 *
 * HARNESS NOTE (deliberately DIFFERENT from `skill-execution.service.
 * integration.test.ts`'s lightweight harness): `ObjectsService` has too many
 * collaborators (AI provider, search-index embedding scheduler, calendar
 * timeblock push, task recurrence, AI usage quotas) to hand-construct
 * directly -- EVERY existing integration test that needs a real
 * `ObjectsService` in this codebase (`object-query.integration.test.ts`,
 * `checklist-recurrence-projection.integration.test.ts`, etc.) boots the full
 * `AppModule` via `Test.createTestingModule({ imports: [AppModule] })` +
 * `app.init()` and resolves it via `app.get(ObjectsService)`, rather than
 * constructing it by hand -- this file follows that EXACT precedent (a real
 * search confirched no integration test anywhere in this codebase constructs
 * `ObjectsService` directly). This requires BOTH Postgres AND Redis
 * Testcontainers (the full `AppModule`'s own `config/env.js` requires
 * `REDIS_URL` to be a non-empty string at boot, and other modules wired into
 * `AppModule` actually connect to it) -- unlike `skill-execution.service.
 * integration.test.ts`'s placeholder `REDIS_URL` (that file never boots
 * `AppModule`).
 *
 * `AgentPermissionManifestsService` and `SkillExecutionService` (+ the
 * process-wide `SKILL_REGISTRY` DI token) are ALSO resolved via `app.get(...)`
 * from the SAME compiled `AppModule` graph (`AgentRuntimeModule`/
 * `SkillsModule` are both already imported by `AppModule`, per F3-T1/F3-T2
 * PR1/PR2) -- guaranteeing this file exercises the REAL, production-wired
 * `SkillExecutionService` -> `SkillRegistry` singleton, not a freshly
 * constructed stand-in.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `./object-skills.ts` exports 9 build functions, each `(objectsService:
 * ObjectsService) => Skill<unknown, unknown>`, named after their catalog id
 * (spec table #1-9) in `buildXSkill` form:
 *   `buildCreateObjectSkill`      -> id `'create-object'`
 *   `buildGetObjectSkill`         -> id `'get-object'`
 *   `buildQueryObjectsSkill`      -> id `'query-objects'`
 *   `buildSetFieldValuesSkill`    -> id `'set-field-values'`
 *   `buildAddChecklistItemSkill`  -> id `'add-checklist-item'`
 *   `buildToggleChecklistItemSkill` -> id `'toggle-checklist-item'`
 *   `buildScheduleTimeBlockSkill` -> id `'schedule-time-block'`
 *   `buildRefreshAIFieldSkill`    -> id `'refresh-ai-field'`
 *   `buildSetRecurrenceRuleSkill` -> id `'set-recurrence-rule'`
 * (exact names are THIS test file's own pinned choice -- the task brief left
 * them unspecified beyond "9 skill-building functions"; picking concrete,
 * conventional names here removes ambiguity for implementer rather than
 * leaving it to be guessed twice.)
 *
 * `create-object`/`query-objects` need NO pre-fetch (their `objectType` is
 * already known from the caller's own input), so this file calls the
 * ALREADY-EXISTING, already-merged `SkillExecutionService.executeSkill(...,
 * objectType)` directly for those two.
 *
 * The other 7 (objectId-based) skills need a PRE-FETCH to learn the target
 * object's REAL type before `executeSkill`'s permission check can run (that
 * check must happen BEFORE `skill.execute`, per ADR-0036 Karar f -- so the
 * `objectType` must be known to the CALLER, not discovered inside `execute`).
 * `./object-skills.ts` ALSO exports the generic caller-side helper the task
 * brief itself proposed verbatim:
 *
 *   `callObjectIdBasedSkill<TOutput>(objectsService, skillExecutionService,
 *   workspaceId, agentIdentifier, skillId, input: Record<string, unknown> &
 *   {objectId: string}): Promise<AgentActionResult<TOutput>>`
 *
 * which (1) calls `objectsService.get(workspaceId, input.objectId, 'member')`
 * to resolve the real object (and its `.type`), (2) calls
 * `skillExecutionService.executeSkill(workspaceId, agentIdentifier, skillId,
 * input, resolvedObject.type)`. For `get-object` specifically, `execute`
 * returns the already-resolved object (implementer's own internal mechanism
 * for avoiding a second fetch, e.g. threading it through `input`, is NOT
 * pinned/asserted by this file -- only the black-box end-to-end result is).
 *
 * SIGNING: this file does NOT rely on `registerSkill()`/the canonical
 * `SKILL_SDK_PUBLIC_KEY_PEM` at all (that constant's matching private key is
 * deliberately not available anywhere in this repo, per `skill-sdk-public-
 * key.ts`'s own doc comment -- reproducing a valid signature against it is
 * not something a test can do, and is out of scope for what this PR's
 * acceptance criteria ask this file to prove). Instead, mirroring
 * `skill-execution.service.integration.test.ts`'s own "construct your own
 * test keypair, call `registry.register(skill, testPublicKeyPem)` directly"
 * convention: this file takes each REAL `Skill` object `object-skills.ts`
 * builds (real `execute`, bound to the real `ObjectsService`), copies its
 * `manifest.id`/`.version`/`.capability` (whatever implementer's own build
 * function happened to sign them with), and RE-SIGNS that same manifest data
 * with a keypair this file owns -- so registration in THIS file's own fresh
 * `SkillRegistry` succeeds regardless of implementer's own production
 * signing-key choice (a separate concern this file deliberately does not
 * pin).
 * ============================================================================
 */

interface ChecklistItemBody {
  id: string;
  text: string;
  done: boolean;
  order: number;
}

interface ObjectWithFieldValuesLike {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lifecycle: string;
  checklist: ChecklistItemBody[];
  fieldValues: Record<string, unknown>;
}

interface ObjectsServiceLike {
  create(
    workspaceId: string,
    actor: Actor,
    input: { objectType: string; title: string; causationEventId?: string },
    callerRole: string,
  ): Promise<ObjectWithFieldValuesLike>;
  get(
    workspaceId: string,
    objectId: string,
    callerRole: string,
  ): Promise<ObjectWithFieldValuesLike>;
}

interface AgentPermissionManifestsServiceLike {
  grant(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: {
      agentIdentifier: string;
      dataScope: { objectTypes: string[] | 'all' };
      actionTypes: string[];
      timeWindow: { startsAt: Date | null; expiresAt: Date | null };
    },
  ): Promise<{ id: string; agentIdentifier: string }>;
}

interface SkillExecutionServiceLike {
  executeSkill<TOutput>(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: Record<string, unknown>,
    objectType?: string,
  ): Promise<AgentActionResult<TOutput>>;
}

interface ObjectSkillsModuleLike {
  buildCreateObjectSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildGetObjectSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildQueryObjectsSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildSetFieldValuesSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildAddChecklistItemSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildToggleChecklistItemSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildScheduleTimeBlockSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildRefreshAIFieldSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  buildSetRecurrenceRuleSkill(objectsService: ObjectsServiceLike): Skill<unknown, unknown>;
  callObjectIdBasedSkill<TOutput>(
    objectsService: ObjectsServiceLike,
    skillExecutionService: SkillExecutionServiceLike,
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: Record<string, unknown> & { objectId: string },
  ): Promise<AgentActionResult<TOutput>>;
}

/** The exact catalog ids this PR's 9 skills must be registered under (spec table #1-9). */
const EXPECTED_SKILL_IDS = [
  'create-object',
  'get-object',
  'query-objects',
  'set-field-values',
  'add-checklist-item',
  'toggle-checklist-item',
  'schedule-time-block',
  'refresh-ai-field',
  'set-recurrence-rule',
] as const;

describe('F3-T2 PR3 (RED step): object-skills.ts — 9 first-party skills thinly wrapping ObjectsService (real Postgres + Redis via Testcontainers, full AppModule)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;

  let objectsService: ObjectsServiceLike;
  let permissionsService: AgentPermissionManifestsServiceLike;
  let skillExecutionService: SkillExecutionServiceLike;
  let objectSkillsModule: ObjectSkillsModuleLike;

  let workspaceCounter = 0;
  let agentCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());
    db = createDatabaseClient(container.getConnectionUri());

    // Imported dynamically, AFTER DATABASE_URL/REDIS_URL are set -- per the
    // established convention for every integration test file that needs the
    // full `AppModule` graph (which transitively evaluates `config/env.js`
    // at import time).
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (
      objectsServiceModule as { ObjectsService: Type<ObjectsServiceLike> }
    ).ObjectsService;
    objectsService = app.get(ObjectsServiceCtor);

    const permissionsModule: unknown =
      await import('../agent-runtime/agent-permission-manifests.service.js');
    const AgentPermissionManifestsServiceCtor = (
      permissionsModule as {
        AgentPermissionManifestsService: Type<AgentPermissionManifestsServiceLike>;
      }
    ).AgentPermissionManifestsService;
    permissionsService = app.get(AgentPermissionManifestsServiceCtor);

    const skillExecutionModule: unknown = await import('./skill-execution.service.js');
    const SkillExecutionServiceCtor = (
      skillExecutionModule as { SkillExecutionService: Type<SkillExecutionServiceLike> }
    ).SkillExecutionService;
    skillExecutionService = app.get(SkillExecutionServiceCtor);

    // `SkillsModule`'s own factory (part of `AppModule`, already merged since
    // PR3) registers these exact 9 skills into the SAME process-wide
    // `SKILL_REGISTRY` this test's `skillExecutionService` resolves against
    // -- via `OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM`, its own real production
    // keypair. Re-registering them here under a second, test-owned keypair
    // (as an earlier version of this file did) throws `ConflictError` on the
    // SAME already-populated registry instance -- this bug went undetected
    // because `*.integration.test.ts` was never wired into CI until the
    // ci/wire-integration-tests PR, and Docker was unavailable in every dev
    // sandbox that touched this file. Fixed by simply relying on
    // `SkillsModule`'s own already-completed registration instead of
    // duplicating it -- no need to import/build/re-sign the skills at all.
    const objectSkillsModulePath = './object-skills.js';
    const objectSkillsModuleRaw: unknown = await import(objectSkillsModulePath);
    objectSkillsModule = objectSkillsModuleRaw as ObjectSkillsModuleLike;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 120_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `object-skills-test-workspace-${String(workspaceCounter)}`,
        slug: `object-skills-test-workspace-${String(workspaceCounter)}`,
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

  function freshAgentIdentifier(label: string): string {
    agentCounter += 1;
    return `object-skills-test-${label}-agent-${String(agentCounter)}`;
  }

  /** Asserts `result.outcome === 'success'` and returns the narrowed `value`. */
  function unwrapSuccess<T>(result: AgentActionResult<T>): T {
    if (result.outcome !== 'success') {
      throw new Error(`Expected a successful AgentActionResult, got: ${JSON.stringify(result)}`);
    }
    return result.value;
  }

  it('1. all 9 skills are registered under their exact catalog ids, retrievable via registry.get(id)', async () => {
    // `object-skills.ts` is dynamically imported and its 9 skills registered
    // ONCE in `beforeAll` (shared across this whole file) -- this test only
    // asserts on that already-completed registration.
    const skillExecutionModule: unknown = await import('./skill-execution.service.js');
    const SKILL_REGISTRY_TOKEN = (skillExecutionModule as { SKILL_REGISTRY: symbol })
      .SKILL_REGISTRY;
    const skillRegistry = app.get<SkillRegistry>(SKILL_REGISTRY_TOKEN);

    for (const id of EXPECTED_SKILL_IDS) {
      const registered = skillRegistry.get(id);
      expect(registered).toBeDefined();
      expect(registered?.manifest.id).toBe(id);
    }
  });

  it('2. create-object: succeeds and REALLY persists for an allowed objectType; the SAME manifest denies a different, non-allowed objectType', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('create-object');

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['create-object'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await skillExecutionService.executeSkill<ObjectWithFieldValuesLike>(
      workspaceId,
      agentIdentifier,
      'create-object',
      { objectType: 'task', title: 'Skill-created task' },
      'task',
    );
    const created = unwrapSuccess(result);
    expect(created.type).toBe('task');
    expect(created.title).toBe('Skill-created task');

    // Independently verify REAL persistence (not just a well-shaped return
    // value) via a separate `objectsService.get` call.
    const fetched = await objectsService.get(workspaceId, created.id, 'member');
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe('Skill-created task');

    // The SAME manifest (still scoped to `objectTypes: ['task']`) must deny
    // a `meeting` -- proves `dataScope.objectTypes` narrowing genuinely
    // applies to `create-object`.
    await expect(
      skillExecutionService.executeSkill(
        workspaceId,
        agentIdentifier,
        'create-object',
        { objectType: 'meeting', title: 'Should be denied' },
        'meeting',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('3. get-object: returns the real object when authorized; a manifest narrowed to "task" denies fetching a DIFFERENT object whose ACTUAL type is "meeting", even though the caller only ever supplies an objectId', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('get-object');
    const actor = fakeActor();

    const task = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'Real task' },
      'member',
    );
    const meeting = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'meeting', title: 'Real meeting' },
      'member',
    );

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['get-object'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const taskResult = await objectSkillsModule.callObjectIdBasedSkill<ObjectWithFieldValuesLike>(
      objectsService,
      skillExecutionService,
      workspaceId,
      agentIdentifier,
      'get-object',
      { objectId: task.id },
    );
    const fetchedTask = unwrapSuccess(taskResult);
    expect(fetchedTask.id).toBe(task.id);
    expect(fetchedTask.title).toBe('Real task');

    // Re-grant (upsert) the SAME agent, now narrowed to `objectTypes: ['task']`.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['get-object'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    // The caller supplies ONLY `meeting.id` -- the wrapper must resolve the
    // object's REAL type (meeting) via its own pre-fetch and deny based on
    // THAT, not on any type the caller could have (but did not) assert.
    await expect(
      objectSkillsModule.callObjectIdBasedSkill(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        'get-object',
        { objectId: meeting.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('4. add-checklist-item generalizes the SAME dataScope-by-actual-type narrowing beyond the read-only get-object skill', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('add-checklist-item-scope');
    const actor = fakeActor();

    const task = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'Task A' },
      'member',
    );
    const meeting = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'meeting', title: 'Meeting A' },
      'member',
    );

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['add-checklist-item'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const okResult = await objectSkillsModule.callObjectIdBasedSkill<ObjectWithFieldValuesLike>(
      objectsService,
      skillExecutionService,
      workspaceId,
      agentIdentifier,
      'add-checklist-item',
      { objectId: task.id, text: 'Allowed item' },
    );
    unwrapSuccess(okResult);

    // Re-grant (upsert), narrowed to `objectTypes: ['task']` only.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['add-checklist-item'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      objectSkillsModule.callObjectIdBasedSkill(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        'add-checklist-item',
        { objectId: meeting.id, text: 'Should be denied' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The denied attempt must never have mutated the meeting object.
    const fetchedMeeting = await objectsService.get(workspaceId, meeting.id, 'member');
    expect(fetchedMeeting.checklist).toHaveLength(0);
  });

  it('5. cross-workspace isolation: a manifest granted only in workspace A does not authorize get-object against workspace B, even for a real object that genuinely exists in B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('cross-workspace-get-object');
    const actor = fakeActor();

    const taskInA = await objectsService.create(
      workspaceIdA,
      actor,
      { objectType: 'task', title: 'Task in A' },
      'member',
    );
    const taskInB = await objectsService.create(
      workspaceIdB,
      actor,
      { objectType: 'task', title: 'Task in B' },
      'member',
    );

    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['get-object'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const resultInA = await objectSkillsModule.callObjectIdBasedSkill<ObjectWithFieldValuesLike>(
      objectsService,
      skillExecutionService,
      workspaceIdA,
      agentIdentifier,
      'get-object',
      { objectId: taskInA.id },
    );
    expect(unwrapSuccess(resultInA).id).toBe(taskInA.id);

    // Sanity-checked-in-the-same-test: the SAME agentIdentifier, with a
    // manifest granted ONLY in workspace A, must be denied in workspace B --
    // even though a real, genuine task exists there under `taskInB.id`.
    await expect(
      objectSkillsModule.callObjectIdBasedSkill(
        objectsService,
        skillExecutionService,
        workspaceIdB,
        agentIdentifier,
        'get-object',
        { objectId: taskInB.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('6. add-checklist-item genuinely mutates the object (not a no-op): independently verified via a separate objectsService.get call', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('add-checklist-item-mutation');
    const actor = fakeActor();

    const task = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'Checklist task' },
      'member',
    );

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['add-checklist-item'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await objectSkillsModule.callObjectIdBasedSkill<ObjectWithFieldValuesLike>(
      objectsService,
      skillExecutionService,
      workspaceId,
      agentIdentifier,
      'add-checklist-item',
      { objectId: task.id, text: 'Buy milk' },
    );
    unwrapSuccess(result);

    const fetched = await objectsService.get(workspaceId, task.id, 'member');
    expect(fetched.checklist).toHaveLength(1);
    expect(fetched.checklist[0]?.text).toBe('Buy milk');
    expect(fetched.checklist[0]?.done).toBe(false);
  });
});
