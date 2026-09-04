import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { MockMeetingBotClient } from '@luminaos/integrations';
import { ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';
import { signSkillManifest, SkillRegistry } from '@luminaos/skill-sdk';
import type { Skill } from '@luminaos/skill-sdk';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { MEETING_BOT_CLIENT } from '../notetaker/meeting-bot-client.token.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T2 PR4 (RED step, file 1 of 2), ADR-0036 — `apps/server/src/skills/
 * meeting-recurrence-skills.ts`: catalog #10-12 (spec table) --
 * `generate-next-recurrence` (`TaskRecurrenceService.generateNextOccurrence`),
 * `invite-meeting-bot` (`MeetingsService.inviteBot`), `get-meeting-details`
 * (`MeetingsService.getMeetingDetails`). Each a thin wrapper, same conventions
 * as PR3's already-merged `object-skills.ts` (fixed `CALLER_ROLE = 'member'`,
 * `actor = {type:'agent', id: agentIdentifier}`, `parseSkillInput`+zod
 * validation, Ed25519-signed manifests via `signSkillManifest`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./meeting-recurrence-skills.ts` does not exist
 * at all, so the dynamic `import('./meeting-recurrence-skills.js')` call
 * inside `beforeAll` REJECTS ("Cannot find module"), failing every `it` in
 * this file -- mirrors `object-skills.integration.test.ts`'s own documented
 * "module doesn't exist yet" red state. `./skill-execution.service.ts`,
 * `../objects/objects.service.ts`, `../recurrence/task-recurrence.service.ts`,
 * `../notetaker/meetings.service.ts`, and `../agent-runtime/agent-permission-
 * manifests.service.ts` all already exist (merged) -- this file dynamically
 * imports them too, ONLY to control exactly when they (and their transitive
 * `../config/env.js` dependency) are evaluated relative to this file's own
 * `process.env.DATABASE_URL`/`REDIS_URL` assignment in `beforeAll` -- NOT
 * because they are themselves missing.
 *
 * HARNESS NOTE: identical full-`AppModule`-boot Testcontainers (Postgres 16 +
 * Redis 7) harness as `object-skills.integration.test.ts` -- same rationale
 * (too many collaborators to hand-construct `ObjectsService`/`MeetingsService`
 * directly). Additionally overrides `MEETING_BOT_CLIENT` with a single shared
 * `MockMeetingBotClient` instance (mirrors `meeting-invite.controller.
 * integration.test.ts`'s own override), so `invite-meeting-bot` never talks
 * to a real third-party vendor.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `./meeting-recurrence-skills.ts` exports 3 build functions, each named
 * after their catalog id in `buildXSkill` form:
 *   `buildGenerateNextRecurrenceSkill(taskRecurrenceService: TaskRecurrenceService)`
 *     -> id `'generate-next-recurrence'`
 *   `buildInviteMeetingBotSkill(meetingsService: MeetingsService)`
 *     -> id `'invite-meeting-bot'`
 *   `buildGetMeetingDetailsSkill(meetingsService: MeetingsService)`
 *     -> id `'get-meeting-details'`
 *
 * `invite-meeting-bot`/`get-meeting-details` need NO pre-fetch: their
 * `objectType` is ALWAYS, STATICALLY `'meeting'` (mirrors PR3's `create-object`
 * -- the caller of `executeSkill` passes `'meeting'` as the 5th argument
 * directly, exactly as this file's own tests do below).
 *
 * `generate-next-recurrence` IS objectId-based (its `sourceObjectId` is an
 * existing object whose real type must be resolved BEFORE the permission
 * check, per ADR-0036 Karar f) -- but its caller-supplied field is named
 * `sourceObjectId`, not `objectId`, so it is NOT compatible with PR3's
 * `callObjectIdBasedSkill` (that helper's own zod pre-check is hardcoded to
 * an `objectId` field). Per this task's own explicit "your call" allowance,
 * this file pins a ONE-OFF, sibling equivalent instead of generalizing that
 * already-established, already-tested helper's signature:
 *
 *   `callGenerateNextRecurrenceSkill<TOutput>(objectsService,
 *   skillExecutionService, workspaceId, agentIdentifier, input:
 *   Record<string, unknown> & {sourceObjectId: string}):
 *   Promise<AgentActionResult<TOutput>>`
 *
 * which (1) calls `objectsService.get(workspaceId, input.sourceObjectId,
 * 'member')` to resolve the source task's REAL type, (2) calls
 * `skillExecutionService.executeSkill(workspaceId, agentIdentifier,
 * 'generate-next-recurrence', input, resolvedObject.type)`.
 *
 * `generate-next-recurrence`'s `execute` itself builds
 * `TaskRecurrenceService.generateNextOccurrence`'s single object argument as:
 *   `{ workspaceId, actor: {type:'agent', id: agentIdentifier}, sourceObjectId,
 *      causationEventId: input.causationEventId ?? randomUUID(),
 *      nextOccurrence }`
 * -- `causationEventId` is OPTIONAL from the skill CALLER's perspective (a
 * caller wanting idempotent retries supplies their own stable id; one who
 * doesn't gets a fresh `randomUUID()` generated by the skill itself, a NEW
 * one on every call that omits it).
 *
 * SIGNING: same re-signing-against-a-locally-owned-test-keypair convention as
 * `object-skills.integration.test.ts` (this file's own fresh `SkillRegistry`,
 * not the canonical `SKILL_SDK_PUBLIC_KEY_PEM`, whose matching private key is
 * deliberately absent from this repo).
 * ============================================================================
 */

interface ObjectWithFieldValuesLike {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lifecycle: string;
  checklist: unknown[];
  fieldValues: Record<string, unknown>;
}

interface ObjectsServiceLike {
  create(
    workspaceId: string,
    actor: Actor,
    input: { objectType: string; title: string },
    callerRole: string,
  ): Promise<ObjectWithFieldValuesLike>;
  get(
    workspaceId: string,
    objectId: string,
    callerRole: string,
  ): Promise<ObjectWithFieldValuesLike>;
}

interface EventStoreServiceLike {
  readByWorkspace(workspaceId: string, fromPosition: number): Promise<{ type: string }[]>;
}

interface GenerateNextOccurrenceResultLike {
  object: { id: string; type: string; title: string };
  fieldValues: Record<string, unknown>;
  relation: { id: string; fromId: string; toId: string; kind: string };
}

interface TaskRecurrenceServiceLike {
  generateNextOccurrence(input: {
    workspaceId: string;
    actor: Actor;
    sourceObjectId: string;
    causationEventId: string;
    nextOccurrence: { title: string; fieldValues: Record<string, unknown> };
  }): Promise<GenerateNextOccurrenceResultLike>;
}

interface MeetingDetailsRowLike {
  id: string;
  objectId: string;
  meetingUrl: string;
  provider: string;
  status: string;
  providerMeetingRef: string;
}

interface MeetingMetadataLike {
  id: string;
  title: string;
  meetingUrl: string;
  provider: string;
  status: string;
  createdAt: string;
  transcriptText?: string | null;
}

interface MeetingsServiceLike {
  inviteBot(
    workspaceId: string,
    actor: Actor,
    callerRole: string,
    input: { meetingUrl: string },
  ): Promise<{ object: ObjectWithFieldValuesLike; meetingDetails: MeetingDetailsRowLike }>;
  getMeetingDetails(
    workspaceId: string,
    meetingId: string,
    callerRole: string,
  ): Promise<{ meeting: MeetingMetadataLike }>;
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

interface MeetingRecurrenceSkillsModuleLike {
  buildGenerateNextRecurrenceSkill(
    taskRecurrenceService: TaskRecurrenceServiceLike,
  ): Skill<unknown, unknown>;
  buildInviteMeetingBotSkill(meetingsService: MeetingsServiceLike): Skill<unknown, unknown>;
  buildGetMeetingDetailsSkill(meetingsService: MeetingsServiceLike): Skill<unknown, unknown>;
  callGenerateNextRecurrenceSkill<TOutput>(
    objectsService: ObjectsServiceLike,
    skillExecutionService: SkillExecutionServiceLike,
    workspaceId: string,
    agentIdentifier: string,
    input: Record<string, unknown> & { sourceObjectId: string },
  ): Promise<AgentActionResult<TOutput>>;
}

/** The exact catalog ids this PR's 3 skills must be registered under (spec table #10-12). */
const EXPECTED_SKILL_IDS = [
  'generate-next-recurrence',
  'invite-meeting-bot',
  'get-meeting-details',
] as const;

describe('F3-T2 PR4 (RED step, 1/2): meeting-recurrence-skills.ts — generate-next-recurrence, invite-meeting-bot, get-meeting-details (real Postgres + Redis via Testcontainers, full AppModule)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;
  let mockBotClient: MockMeetingBotClient;

  let objectsService: ObjectsServiceLike;
  let eventStore: EventStoreServiceLike;
  let permissionsService: AgentPermissionManifestsServiceLike;
  let skillExecutionService: SkillExecutionServiceLike;
  let meetingsService: MeetingsServiceLike;
  let meetingRecurrenceSkillsModule: MeetingRecurrenceSkillsModuleLike;

  let workspaceCounter = 0;
  let agentCounter = 0;

  function generateEd25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    };
  }

  function reSignForTestRegistry(
    skill: Skill<unknown, unknown>,
    keyPair: { privateKeyPem: string; publicKeyPem: string },
  ): Skill<unknown, unknown> {
    const unsigned = {
      id: skill.manifest.id,
      version: skill.manifest.version,
      capability: skill.manifest.capability,
    };
    const signature = signSkillManifest(unsigned, keyPair.privateKeyPem);
    return {
      manifest: { ...unsigned, signature },
      execute: (input: unknown) => skill.execute(input),
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());
    db = createDatabaseClient(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    mockBotClient = new MockMeetingBotClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MEETING_BOT_CLIENT)
      .useValue(mockBotClient)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (
      objectsServiceModule as { ObjectsService: Type<ObjectsServiceLike> }
    ).ObjectsService;
    objectsService = app.get(ObjectsServiceCtor);

    const eventStoreModule: unknown = await import('../event-store/event-store.service.js');
    const EventStoreServiceCtor = (
      eventStoreModule as { EventStoreService: Type<EventStoreServiceLike> }
    ).EventStoreService;
    eventStore = app.get(EventStoreServiceCtor);

    const taskRecurrenceModule: unknown = await import('../recurrence/task-recurrence.service.js');
    const TaskRecurrenceServiceCtor = (
      taskRecurrenceModule as { TaskRecurrenceService: Type<TaskRecurrenceServiceLike> }
    ).TaskRecurrenceService;
    const taskRecurrenceService = app.get(TaskRecurrenceServiceCtor);

    const meetingsServiceModule: unknown = await import('../notetaker/meetings.service.js');
    const MeetingsServiceCtor = (
      meetingsServiceModule as { MeetingsService: Type<MeetingsServiceLike> }
    ).MeetingsService;
    meetingsService = app.get(MeetingsServiceCtor);

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
    const SKILL_REGISTRY_TOKEN = (skillExecutionModule as { SKILL_REGISTRY: symbol })
      .SKILL_REGISTRY;
    skillExecutionService = app.get(SkillExecutionServiceCtor);
    const skillRegistry = app.get<SkillRegistry>(SKILL_REGISTRY_TOKEN);

    // ==========================================================================
    // RED: `./meeting-recurrence-skills.ts` does not exist yet -- this dynamic
    // import rejects with "Cannot find module", failing every `it` below.
    // ==========================================================================
    const meetingRecurrenceSkillsModulePath = './meeting-recurrence-skills.js';
    const meetingRecurrenceSkillsModuleRaw: unknown = await import(
      meetingRecurrenceSkillsModulePath
    );
    meetingRecurrenceSkillsModule =
      meetingRecurrenceSkillsModuleRaw as MeetingRecurrenceSkillsModuleLike;

    const registryKeyPair = generateEd25519Pem();
    const builtSkills: Skill<unknown, unknown>[] = [
      meetingRecurrenceSkillsModule.buildGenerateNextRecurrenceSkill(taskRecurrenceService),
      meetingRecurrenceSkillsModule.buildInviteMeetingBotSkill(meetingsService),
      meetingRecurrenceSkillsModule.buildGetMeetingDetailsSkill(meetingsService),
    ];

    for (const skill of builtSkills) {
      skillRegistry.register(
        reSignForTestRegistry(skill, registryKeyPair),
        registryKeyPair.publicKeyPem,
      );
    }
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
        name: `meeting-recurrence-skills-test-workspace-${String(workspaceCounter)}`,
        slug: `meeting-recurrence-skills-test-workspace-${String(workspaceCounter)}`,
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
    return `meeting-recurrence-skills-test-${label}-agent-${String(agentCounter)}`;
  }

  function unwrapSuccess<T>(result: AgentActionResult<T>): T {
    if (result.outcome !== 'success') {
      throw new Error(`Expected a successful AgentActionResult, got: ${JSON.stringify(result)}`);
    }
    return result.value;
  }

  /**
   * `TaskRecurrenceService.generateNextOccurrence` is NOT wired into
   * `ObjectsService`'s own `objects_view`/`relations_view` projections (a
   * documented, accepted gap from that service's own doc comment) -- it only
   * appends events. Verifying real persistence therefore reads the EVENT
   * STORE directly, mirroring `task-recurrence.service.test.ts`'s own
   * `countEventsByType` helper, rather than `objectsService.get` (which
   * reads the read-model projection and would see nothing, since no
   * catch-up has run).
   */
  async function countEventsByType(workspaceId: string, type: string): Promise<number> {
    const events = await eventStore.readByWorkspace(workspaceId, 0);
    return events.filter((event) => event.type === type).length;
  }

  it('1. all 3 skills are registered under their exact catalog ids, retrievable via registry.get(id)', async () => {
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

  it('2. invite-meeting-bot: succeeds and REALLY creates a meeting object + meeting_details row when the manifest is scoped to "meeting"; the SAME manifest denies when re-narrowed to "task" only', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('invite-meeting-bot');

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['meeting'] },
      actionTypes: ['invite-meeting-bot'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await skillExecutionService.executeSkill<{
      object: ObjectWithFieldValuesLike;
      meetingDetails: MeetingDetailsRowLike;
    }>(
      workspaceId,
      agentIdentifier,
      'invite-meeting-bot',
      { meetingUrl: 'https://meet.google.com/skill-invite-abc' },
      'meeting',
    );
    const created = unwrapSuccess(result);
    expect(created.object.type).toBe('meeting');
    expect(created.meetingDetails.meetingUrl).toBe('https://meet.google.com/skill-invite-abc');

    // Independently verify REAL persistence via a separate MeetingsService call.
    const fetched = await meetingsService.getMeetingDetails(
      workspaceId,
      created.object.id,
      'member',
    );
    expect(fetched.meeting.id).toBe(created.object.id);
    expect(fetched.meeting.meetingUrl).toBe('https://meet.google.com/skill-invite-abc');

    // The SAME manifest, now re-granted narrowed to `objectTypes: ['task']`
    // only, must deny -- proves the skill's STATIC `objectType: 'meeting'` is
    // actually being checked, not silently omitted.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['invite-meeting-bot'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      skillExecutionService.executeSkill(
        workspaceId,
        agentIdentifier,
        'invite-meeting-bot',
        { meetingUrl: 'https://zoom.us/j/should-be-denied' },
        'meeting',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('3. get-meeting-details: reads the real meeting when the manifest is scoped to "meeting"; the SAME manifest denies when re-narrowed to "task" only', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('get-meeting-details');
    const actor = fakeActor();

    const invited = await meetingsService.inviteBot(workspaceId, actor, 'member', {
      meetingUrl: 'https://meet.google.com/get-details-setup',
    });

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['meeting'] },
      actionTypes: ['get-meeting-details'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await skillExecutionService.executeSkill<{ meeting: MeetingMetadataLike }>(
      workspaceId,
      agentIdentifier,
      'get-meeting-details',
      { meetingId: invited.object.id },
      'meeting',
    );
    const fetched = unwrapSuccess(result);
    expect(fetched.meeting.id).toBe(invited.object.id);
    expect(fetched.meeting.meetingUrl).toBe('https://meet.google.com/get-details-setup');

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['get-meeting-details'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      skillExecutionService.executeSkill(
        workspaceId,
        agentIdentifier,
        'get-meeting-details',
        { meetingId: invited.object.id },
        'meeting',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('4. generate-next-recurrence: creates a REAL new task object + recurrenceOf relation (independently verified); a SECOND call with the IDENTICAL causationEventId resolves to the SAME object/relation ids, not a second object', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('generate-next-recurrence');
    const actor = fakeActor();

    const sourceTask = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'Weekly standup' },
      'member',
    );

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['generate-next-recurrence'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const causationEventId = randomUUID();
    const input = {
      sourceObjectId: sourceTask.id,
      causationEventId,
      nextOccurrence: { title: 'Weekly standup (next)', fieldValues: { priority: 'medium' } },
    };

    const firstResult =
      await meetingRecurrenceSkillsModule.callGenerateNextRecurrenceSkill<GenerateNextOccurrenceResultLike>(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        input,
      );
    const first = unwrapSuccess(firstResult);
    expect(first.object.type).toBe('task');
    expect(first.object.title).toBe('Weekly standup (next)');
    expect(first.relation.fromId).toBe(sourceTask.id);
    expect(first.relation.toId).toBe(first.object.id);

    // Independently verify REAL persistence via the event store (NOT
    // `objectsService.get`, which reads `objects_view` -- a projection
    // `generateNextOccurrence` never catches up, per its own documented
    // gap; see `countEventsByType`'s doc comment above).
    expect(await countEventsByType(workspaceId, 'ObjectCreated')).toBe(1);
    expect(await countEventsByType(workspaceId, 'RelationCreated')).toBe(1);

    const secondResult =
      await meetingRecurrenceSkillsModule.callGenerateNextRecurrenceSkill<GenerateNextOccurrenceResultLike>(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        input,
      );
    const second = unwrapSuccess(secondResult);
    expect(second.object.id).toBe(first.object.id);
    expect(second.relation.id).toBe(first.relation.id);
    // The idempotent replay must not append a SECOND pair of events.
    expect(await countEventsByType(workspaceId, 'ObjectCreated')).toBe(1);
    expect(await countEventsByType(workspaceId, 'RelationCreated')).toBe(1);
  });

  it('5. generate-next-recurrence: when the caller OMITS causationEventId, the skill generates a fresh one itself on EACH call -- two such calls produce TWO DIFFERENT objects, never an accidental idempotent collision', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('generate-next-recurrence-no-causation-id');
    const actor = fakeActor();

    const sourceTask = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'Daily sync' },
      'member',
    );

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['generate-next-recurrence'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const inputWithoutCausationEventId = {
      sourceObjectId: sourceTask.id,
      nextOccurrence: { title: 'Daily sync (next)', fieldValues: {} },
    };

    const firstResult =
      await meetingRecurrenceSkillsModule.callGenerateNextRecurrenceSkill<GenerateNextOccurrenceResultLike>(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        inputWithoutCausationEventId,
      );
    const secondResult =
      await meetingRecurrenceSkillsModule.callGenerateNextRecurrenceSkill<GenerateNextOccurrenceResultLike>(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        inputWithoutCausationEventId,
      );

    const first = unwrapSuccess(firstResult);
    const second = unwrapSuccess(secondResult);
    expect(second.object.id).not.toBe(first.object.id);
  });

  it('6. cross-workspace isolation: a manifest granted only in workspace A does not authorize generate-next-recurrence against workspace B, even for a source task that genuinely exists in B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('cross-workspace-recurrence');
    const actor = fakeActor();

    const taskInB = await objectsService.create(
      workspaceIdB,
      actor,
      { objectType: 'task', title: 'Task in B' },
      'member',
    );

    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['generate-next-recurrence'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      meetingRecurrenceSkillsModule.callGenerateNextRecurrenceSkill(
        objectsService,
        skillExecutionService,
        workspaceIdB,
        agentIdentifier,
        {
          sourceObjectId: taskInB.id,
          nextOccurrence: { title: 'Should be denied', fieldValues: {} },
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
