import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { ForbiddenError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';
import { signSkillManifest, SkillRegistry } from '@luminaos/skill-sdk';
import type { Skill } from '@luminaos/skill-sdk';

import { callObjectIdBasedSkill } from './object-skills.js';
import { ContextGraphSyncWorker } from '../context/context-graph-sync.worker.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';
import { calendarEventsCache } from '../db/schema/calendar-events-cache.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';
import type { ObjectsService } from '../objects/objects.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T2 PR4 (RED step, file 2 of 2), ADR-0036 — `apps/server/src/skills/
 * context-search-calendar-skills.ts`: catalog #13-15 (spec table) --
 * `get-object-context` (`ContextService.getContext`), `search-connected-
 * sources` (`ConnectedSearchService.searchExternal`), `list-cached-calendar-
 * events` (`CalendarEventsService.listCachedEvents`). Same conventions as
 * PR3's merged `object-skills.ts` / PR4's sibling `meeting-recurrence-
 * skills.ts` (fixed `CALLER_ROLE = 'member'`, `actor = {type:'agent', id:
 * agentIdentifier}` where an actor is needed at all, `parseSkillInput`+zod
 * validation, Ed25519-signed manifests).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./context-search-calendar-skills.ts` does not
 * exist at all, so the dynamic `import('./context-search-calendar-skills.js')`
 * call inside `beforeAll` REJECTS ("Cannot find module"), failing every `it`
 * in this file -- mirrors `object-skills.integration.test.ts`'s own
 * documented "module doesn't exist yet" red state. `./object-skills.ts`
 * (imported here as a plain, real, ALREADY-MERGED value import purely to
 * reuse its exported `callObjectIdBasedSkill` helper -- no special import-
 * timing concern applies to it, unlike this file's own under-test module) and
 * `../context/context.service.ts`, `../search/connected-search.service.ts`,
 * `../calendar/calendar-events.service.ts`, `../integrations/connector-
 * credentials.service.ts` all already exist (merged) -- this file dynamically
 * imports THOSE, ONLY to control exactly when they (and their transitive
 * `../config/env.js` dependency) are evaluated relative to this file's own
 * env-var assignments in `beforeAll`.
 *
 * HARNESS NOTE: identical full-`AppModule`-boot Testcontainers (Postgres 16 +
 * Redis 7) harness as `object-skills.integration.test.ts` / `meeting-
 * recurrence-skills.integration.test.ts`. `ENCRYPTION_KEY` is ALSO set (same
 * value/shape as `calendar-events.integration.test.ts`'s own precedent) --
 * required by `ConnectorCredentialsService.store`/`.retrieve`, used directly
 * by this file's `search-connected-sources` tests. `get-object-context`
 * additionally needs `ContextGraphSyncWorker.syncOnce()` driven directly after
 * seeding objects (mirrors `context.integration.test.ts`'s own precedent) --
 * `ContextService.getContext` 404s until the context-graph projection has
 * caught up at least once.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `./context-search-calendar-skills.ts` exports 3 build functions:
 *   `buildGetObjectContextSkill(contextService: ContextService)`
 *     -> id `'get-object-context'`
 *   `buildSearchConnectedSourcesSkill(connectedSearchService: ConnectedSearchService)`
 *     -> id `'search-connected-sources'`
 *   `buildListCachedCalendarEventsSkill(calendarEventsService: CalendarEventsService)`
 *     -> id `'list-cached-calendar-events'`
 *
 * `get-object-context` IS objectId-based (its `objectId` is an existing
 * object whose real type must be resolved BEFORE the permission check, per
 * ADR-0036 Karar f) -- and, unlike `generate-next-recurrence`'s
 * `sourceObjectId`, its caller-supplied field IS literally named `objectId`,
 * so it IS compatible with PR3's already-merged, already-tested
 * `callObjectIdBasedSkill` (reused here UNCHANGED, imported directly from
 * `./object-skills.ts` -- see that helper's own doc comment for its exact
 * pre-fetch-then-`executeSkill` contract). `execute` itself just calls
 * `contextService.getContext(workspaceId, objectId, 'member', options)` --
 * no pre-fetched-object-reuse trick (same "no unforgeable channel" reasoning
 * as `get-object`'s own doc comment in `object-skills.ts`).
 *
 * `search-connected-sources` and `list-cached-calendar-events` are BOTH
 * non-object-scoped (no `objectId`/`objectType` involved at all, mirroring
 * PR2's already-accepted `objectType`-omission gap for non-object-scoped
 * skills) -- this file's own tests call `skillExecutionService.executeSkill(
 * ..., input)` directly, WITHOUT a 5th `objectType` argument, for both.
 *
 * `search-connected-sources` is a SECURITY-CRITICAL wrapper (documented in
 * this task's own instructions and in the skill's own doc comment,
 * implementer-side): its input schema declares NO `userId` field at all --
 * `execute` calls `connectedSearchService.searchExternal(workspaceId,
 * agentIdentifier, query)`, using the agent's OWN identifier in the `userId`
 * slot (no caller-suppliable "act as this human user" channel exists in the
 * current agent-permission-manifest model at all -- accepting one would let
 * any agent read ANY human user's connected-account credentials). Since no
 * normal OAuth connect flow ever stores credentials under an agent
 * identifier, this is SAFE BY CONSTRUCTION (empty results) but functionally
 * inert pending a future agent-to-user credential-delegation design -- this
 * file's own tests 4/5 pin exactly that.
 *
 * SIGNING: same re-signing-against-a-locally-owned-test-keypair convention as
 * the other two skills files in this PR/PR3.
 * ============================================================================
 */

interface ContextResponseLike {
  asOf: string;
  entity: {
    entityId: string;
    objectType: string;
    title: string;
    fieldValues: Record<string, unknown>;
  };
  edges: unknown[];
}

interface ContextServiceLike {
  getContext(
    workspaceId: string,
    objectId: string,
    callerRole: string,
    options?: { sort?: 'relevance' },
  ): Promise<ContextResponseLike>;
}

interface ContextGraphSyncWorkerLike {
  syncOnce(): Promise<void>;
}

interface ExternalSearchResultLike {
  connectorType: string;
  title: string;
  snippet: string;
}

interface ConnectedSearchResponseLike {
  results: ExternalSearchResultLike[];
  degraded: string[];
}

interface ConnectedSearchServiceLike {
  searchExternal(
    workspaceId: string,
    userId: string,
    query: string,
  ): Promise<ConnectedSearchResponseLike>;
}

interface CachedCalendarEventLike {
  externalId: string;
  title: string;
  start: string;
  end: string;
  meetingUrl?: string;
}

interface CalendarEventsServiceLike {
  listCachedEvents(
    workspaceId: string,
    range: { start: string; end: string },
  ): Promise<CachedCalendarEventLike[]>;
}

interface ConnectorCredentialsServiceLike {
  store(
    workspaceId: string,
    userId: string,
    connectorType: string,
    credentials: Record<string, unknown>,
  ): Promise<{ id: string; connectorType: string }>;
  retrieve(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<Record<string, unknown> | undefined>;
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

interface ContextSearchCalendarSkillsModuleLike {
  buildGetObjectContextSkill(contextService: ContextServiceLike): Skill<unknown, unknown>;
  buildSearchConnectedSourcesSkill(
    connectedSearchService: ConnectedSearchServiceLike,
  ): Skill<unknown, unknown>;
  buildListCachedCalendarEventsSkill(
    calendarEventsService: CalendarEventsServiceLike,
  ): Skill<unknown, unknown>;
}

/** The exact catalog ids this PR's 3 skills must be registered under (spec table #13-15). */
const EXPECTED_SKILL_IDS = [
  'get-object-context',
  'search-connected-sources',
  'list-cached-calendar-events',
] as const;

describe('F3-T2 PR4 (RED step, 2/2): context-search-calendar-skills.ts — get-object-context, search-connected-sources, list-cached-calendar-events (real Postgres + Redis via Testcontainers, full AppModule)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;

  let objectsService: ObjectsService;
  let permissionsService: AgentPermissionManifestsServiceLike;
  let skillExecutionService: SkillExecutionServiceLike;
  let contextService: ContextServiceLike;
  let connectedSearchService: ConnectedSearchServiceLike;
  let calendarEventsService: CalendarEventsServiceLike;
  let connectorCredentialsService: ConnectorCredentialsServiceLike;
  let contextGraphSyncWorker: ContextGraphSyncWorkerLike;
  let contextSearchCalendarSkillsModule: ContextSearchCalendarSkillsModuleLike;

  let workspaceCounter = 0;
  let agentCounter = 0;
  let userCounter = 0;

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
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');

    await runMigrations(container.getConnectionUri());
    db = createDatabaseClient(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (objectsServiceModule as { ObjectsService: Type<ObjectsService> })
      .ObjectsService;
    objectsService = app.get(ObjectsServiceCtor);

    const contextServiceModule: unknown = await import('../context/context.service.js');
    const ContextServiceCtor = (
      contextServiceModule as { ContextService: Type<ContextServiceLike> }
    ).ContextService;
    contextService = app.get(ContextServiceCtor);
    contextGraphSyncWorker = app.get(ContextGraphSyncWorker);

    const connectedSearchServiceModule: unknown =
      await import('../search/connected-search.service.js');
    const ConnectedSearchServiceCtor = (
      connectedSearchServiceModule as { ConnectedSearchService: Type<ConnectedSearchServiceLike> }
    ).ConnectedSearchService;
    connectedSearchService = app.get(ConnectedSearchServiceCtor);

    const calendarEventsServiceModule: unknown =
      await import('../calendar/calendar-events.service.js');
    const CalendarEventsServiceCtor = (
      calendarEventsServiceModule as { CalendarEventsService: Type<CalendarEventsServiceLike> }
    ).CalendarEventsService;
    calendarEventsService = app.get(CalendarEventsServiceCtor);

    const connectorCredentialsServiceModule: unknown =
      await import('../integrations/connector-credentials.service.js');
    const ConnectorCredentialsServiceCtor = (
      connectorCredentialsServiceModule as {
        ConnectorCredentialsService: Type<ConnectorCredentialsServiceLike>;
      }
    ).ConnectorCredentialsService;
    connectorCredentialsService = app.get(ConnectorCredentialsServiceCtor);

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
    // RED: `./context-search-calendar-skills.ts` does not exist yet -- this
    // dynamic import rejects with "Cannot find module", failing every `it`
    // below.
    // ==========================================================================
    const contextSearchCalendarSkillsModulePath = './context-search-calendar-skills.js';
    const contextSearchCalendarSkillsModuleRaw: unknown = await import(
      contextSearchCalendarSkillsModulePath
    );
    contextSearchCalendarSkillsModule =
      contextSearchCalendarSkillsModuleRaw as ContextSearchCalendarSkillsModuleLike;

    const registryKeyPair = generateEd25519Pem();
    const builtSkills: Skill<unknown, unknown>[] = [
      contextSearchCalendarSkillsModule.buildGetObjectContextSkill(contextService),
      contextSearchCalendarSkillsModule.buildSearchConnectedSourcesSkill(connectedSearchService),
      contextSearchCalendarSkillsModule.buildListCachedCalendarEventsSkill(calendarEventsService),
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
        name: `context-search-calendar-skills-test-workspace-${String(workspaceCounter)}`,
        slug: `context-search-calendar-skills-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  async function createRealHumanUser(): Promise<string> {
    userCounter += 1;
    const [row] = await db
      .insert(users)
      .values({
        email: `context-search-calendar-skills-test-user-${String(userCounter)}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });
    if (!row) {
      throw new Error('Failed to create test user');
    }
    return row.id;
  }

  /** Directly inserts a `calendar_accounts` row followed by a `calendar_events_cache`
   * row -- both are otherwise only ever populated by the periodic poller, out of
   * scope here (mirrors `export.integration.test.ts`'s own `insertExternalCalendarEvent`
   * bypass-the-poller rationale). */
  async function insertCachedCalendarEvent(params: {
    workspaceId: string;
    userId: string;
    externalId: string;
    title: string;
    eventStart: Date;
    eventEnd: Date;
  }): Promise<void> {
    const [account] = await db
      .insert(calendarAccounts)
      .values({
        workspaceId: params.workspaceId,
        userId: params.userId,
        provider: 'google',
        encryptedAccessToken: 'placeholder-ciphertext',
        encryptedRefreshToken: 'placeholder-ciphertext',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: calendarAccounts.id });

    if (!account) {
      throw new Error('failed to insert calendar_accounts fixture row');
    }

    await db.insert(calendarEventsCache).values({
      calendarAccountId: account.id,
      workspaceId: params.workspaceId,
      externalId: params.externalId,
      title: params.title,
      eventStart: params.eventStart,
      eventEnd: params.eventEnd,
    });
  }

  function fakeActor(): Actor {
    return { type: 'user', id: randomUUID() };
  }

  function freshAgentIdentifier(label: string): string {
    agentCounter += 1;
    return `context-search-calendar-skills-test-${label}-agent-${String(agentCounter)}`;
  }

  function unwrapSuccess<T>(result: AgentActionResult<T>): T {
    if (result.outcome !== 'success') {
      throw new Error(`Expected a successful AgentActionResult, got: ${JSON.stringify(result)}`);
    }
    return result.value;
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

  it('2. get-object-context: returns the real context when authorized; a manifest narrowed to "task" denies fetching context for a DIFFERENT object whose ACTUAL type is "meeting", even though the caller only ever supplies an objectId', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('get-object-context');
    const actor = fakeActor();

    const task = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'Context task' },
      'member',
    );
    const meeting = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'meeting', title: 'Context meeting' },
      'member',
    );

    // The context-graph projection must catch up at least once before
    // `getContext` can resolve either object (mirrors `context.integration.
    // test.ts`'s own `syncOnce()` precedent).
    await contextGraphSyncWorker.syncOnce();

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['get-object-context'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const taskResult = await callObjectIdBasedSkill<ContextResponseLike>(
      objectsService,
      skillExecutionService,
      workspaceId,
      agentIdentifier,
      'get-object-context',
      { objectId: task.id },
    );
    const fetchedTaskContext = unwrapSuccess(taskResult);
    expect(fetchedTaskContext.entity.entityId).toBe(task.id);
    expect(fetchedTaskContext.entity.objectType).toBe('task');

    // Re-grant (upsert), narrowed to `objectTypes: ['task']` only.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['get-object-context'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    // The caller supplies ONLY `meeting.id` -- the wrapper must resolve the
    // object's REAL type (meeting) via its own pre-fetch and deny based on
    // THAT, not on any type the caller could have (but did not) assert.
    await expect(
      callObjectIdBasedSkill(
        objectsService,
        skillExecutionService,
        workspaceId,
        agentIdentifier,
        'get-object-context',
        { objectId: meeting.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('3. cross-workspace isolation: a manifest granted only in workspace A does not authorize get-object-context against workspace B, even for a real object that genuinely exists in B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('cross-workspace-get-object-context');
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
    await contextGraphSyncWorker.syncOnce();

    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['get-object-context'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const resultInA = await callObjectIdBasedSkill<ContextResponseLike>(
      objectsService,
      skillExecutionService,
      workspaceIdA,
      agentIdentifier,
      'get-object-context',
      { objectId: taskInA.id },
    );
    expect(unwrapSuccess(resultInA).entity.entityId).toBe(taskInA.id);

    await expect(
      callObjectIdBasedSkill(
        objectsService,
        skillExecutionService,
        workspaceIdB,
        agentIdentifier,
        'get-object-context',
        { objectId: taskInB.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('4. search-connected-sources: with NO connector credentials stored anywhere, returns an empty, non-throwing result -- safe by construction', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('search-connected-sources-empty');

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['search-connected-sources'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await skillExecutionService.executeSkill<ConnectedSearchResponseLike>(
      workspaceId,
      agentIdentifier,
      'search-connected-sources',
      { query: 'quarterly plan' },
    );
    const searched = unwrapSuccess(result);
    expect(searched.results).toEqual([]);
    expect(searched.degraded).toEqual([]);
  });

  it('5. search-connected-sources: a REAL human user\'s stored connector credentials in the SAME workspace are never retrieved by an agent\'s own search -- proves no cross-user credential leakage (this skill accepts no caller-suppliable "act as this user" input at all)', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('search-connected-sources-cross-user');
    const realHumanUserId = await createRealHumanUser();

    // A genuine human user's real, stored (encrypted) Notion credentials --
    // set up directly against `ConnectorCredentialsService`, exactly as the
    // real OAuth-connect flow would leave behind.
    await connectorCredentialsService.store(workspaceId, realHumanUserId, 'notion', {
      accessToken: 'real-human-users-notion-access-token',
    });

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['search-connected-sources'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await skillExecutionService.executeSkill<ConnectedSearchResponseLike>(
      workspaceId,
      agentIdentifier,
      'search-connected-sources',
      { query: 'quarterly plan' },
    );
    const searched = unwrapSuccess(result);

    // The agent's own search must NEVER surface (or even attempt against, per
    // `degraded`) the real human user's notion credentials -- the skill has
    // no channel to act "as" `realHumanUserId` at all.
    expect(searched.results).toEqual([]);
    expect(searched.degraded).toEqual([]);

    // Sanity check: the real human user's credentials genuinely ARE stored
    // and retrievable (this test would be vacuous otherwise) -- read back
    // directly via the service's own `retrieve`, under the REAL userId,
    // never via the agent/skill path.
    const directRetrieval = await connectorCredentialsService.retrieve(
      workspaceId,
      realHumanUserId,
      'notion',
    );
    expect(directRetrieval).toEqual({ accessToken: 'real-human-users-notion-access-token' });
  });

  it('6. list-cached-calendar-events: reads REAL cached events for the given range', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('list-cached-calendar-events');
    const realHumanUserId = await createRealHumanUser();

    const eventStart = new Date(Date.now() + 3_600_000);
    const eventEnd = new Date(Date.now() + 7_200_000);
    await insertCachedCalendarEvent({
      workspaceId,
      userId: realHumanUserId,
      externalId: 'ext-skill-cached-1',
      title: 'Design review',
      eventStart,
      eventEnd,
    });

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['list-cached-calendar-events'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const queryStart = new Date().toISOString();
    const queryEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await skillExecutionService.executeSkill<CachedCalendarEventLike[]>(
      workspaceId,
      agentIdentifier,
      'list-cached-calendar-events',
      { start: queryStart, end: queryEnd },
    );
    const events = unwrapSuccess(result);
    const match = events.find((event) => event.externalId === 'ext-skill-cached-1');
    expect(match).toBeDefined();
    expect(match?.title).toBe('Design review');
    expect(match?.start).toBe(eventStart.toISOString());
    expect(match?.end).toBe(eventEnd.toISOString());
  });

  it('7. list-cached-calendar-events: an invalid (non ISO-8601) "start" is rejected by the skill\'s own zod validation before any DB read', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('list-cached-calendar-events-invalid-range');

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['list-cached-calendar-events'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    // `ValidationError` is thrown INSIDE the skill's own `execute` (after
    // `executeSkill`'s permission check already passed), so it is caught by
    // `AgentResourceLimitsService.executeAgentAction`'s sandbox
    // (`runInAgentSandbox`, ADR-0035 Karar a: exceptions never escape) and
    // surfaces as a RESOLVED `{outcome:'failure'}`, not a rejection --
    // unlike `NotFoundError`/`ForbiddenError` above, which `executeSkill`
    // itself throws directly, before the sandbox is ever entered.
    const result = await skillExecutionService.executeSkill(
      workspaceId,
      agentIdentifier,
      'list-cached-calendar-events',
      { start: 'not-a-date', end: new Date().toISOString() },
    );
    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });
});
