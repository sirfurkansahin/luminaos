import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveDeterministicUuid, ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T5 PR1 (RED step), ADR-0039 — `AutonomyTierSettingsService`: `set`
 * (admin+, ADR-0039 Karar i's flat admin-gate -- mirrors
 * `AgentPermissionManifestsService.grant`'s exact `hasAtLeastRole(callerRole,
 * 'admin')` guard shape -- REJECTS `tier !== 'propose'` for any
 * `AUTONOMY_GOVERNANCE_FLOOR` action type with `ForbiddenError`, even for an
 * admin caller, ADR-0039 Karar c), `get` (internal, no RBAC, mirrors
 * `AgentPermissionManifestsService.checkPermission`'s no-RBAC-parameter
 * convention), `list` (member+, ADR-0039 Karar i's "Cam Kutu" transparency
 * rationale -- same as `AgentPermissionManifestsService.list`), `resolveTier`
 * (internal, no RBAC -- returns the fail-safe default `'propose'` when no row
 * exists at all, ADR-0039 Karar b).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./autonomy-tier-settings.service.ts` does not
 * exist at all, so the dynamic `import('./autonomy-tier-settings.service.js')`
 * call inside `beforeAll` REJECTS ("Cannot find module"), failing every `it`
 * in this file -- mirrors `agent-permission-manifests.service.integration.
 * test.ts`'s own documented "service doesn't exist yet" red state.
 * `task_autonomy_settings` (schema + migration `0044_*`, also not yet on
 * disk) is likewise expected missing -- this file's `beforeAll` will fail at
 * `runMigrations` resolving no new migration, or at the dynamic import,
 * whichever `implementer` lands first; either is an acceptable RED failure
 * mode, NOT a bug in this test file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) -- this service
 * has no AI-gateway/webhook collaborator, mirroring `agent-permission-
 * manifests.service.integration.test.ts`'s lightweight "direct `new
 * EventStoreService(db)` / `new ProjectionRunner(db, eventStore)`, no full
 * Nest app boot" shape.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `AutonomyTierSettingsService(db, eventStore, projectionRunner)`:
 *   - `set(workspaceId, actionType, tier, actor, callerRole):
 *     Promise<TaskAutonomySetting>` -- admin+ (else `ForbiddenError`); for
 *     any `actionType` in `AUTONOMY_GOVERNANCE_FLOOR` (currently just
 *     `'reconfigureAgentPermissions'`), a request with `tier !== 'propose'`
 *     ALWAYS throws `ForbiddenError`, even for an admin caller (ADR-0039
 *     Karar c) -- BUT setting that same action type's tier TO `'propose'`
 *     (the already-default value, not raising autonomy) is allowed. Writes
 *     `TaskAutonomyTierSet` with actor `{type:'user', id: actor.id}` (the
 *     REAL calling admin, never a fixed system actor at this layer -- that
 *     is only `AUTONOMY_DIAL_ACTOR`'s job, one layer up in `CommandsService`,
 *     PR2's scope). UPSERTS on `(workspaceId, actionType)` (no second row on
 *     a second `set` for the same pair -- the second call's tier wins).
 *   - `get(workspaceId, actionType): Promise<TaskAutonomySetting | null>` --
 *     NO RBAC parameter at all, internal read-point.
 *   - `list(workspaceId, callerRole): Promise<TaskAutonomySetting[]>` --
 *     member+ (else `ForbiddenError`), all rows for `workspaceId`.
 *   - `resolveTier(workspaceId, actionType): Promise<AutonomyTier>` -- NO
 *     RBAC parameter at all; returns `'propose'` (fail-safe default) when no
 *     row exists for `(workspaceId, actionType)`, else the stored tier.
 *
 * Deterministic per-`(workspaceId, actionType)` `streamId` derivation
 * mirrors `AgentPermissionManifestsService.streamIdFor` exactly (ADR-0039
 * §b's own stated precedent) -- `deriveDeterministicUuid(NAMESPACE,
 * `${workspaceId}:${actionType}`)`. `task_autonomy_settings` has NO
 * `streamId` column (ADR-0039's own pinned schema in "Somut Şekiller"), so
 * this MUST be a deterministic re-derivation, not a stored lookup -- a fixed,
 * arbitrary namespace UUID is pinned below as
 * `TASK_AUTONOMY_SETTING_UUID_NAMESPACE`; implementer's own service-side
 * constant of the same name/value is what test #10 (event-log visibility)
 * independently verifies against.
 * ============================================================================
 */

/**
 * Pinned as this test file's OWN contract value -- implementer's
 * `autonomy-tier-settings.service.ts` MUST use this EXACT literal as its
 * `TASK_AUTONOMY_SETTING_UUID_NAMESPACE` constant (mirrors `agent-
 * permission-manifests.service.integration.test.ts`'s identical convention
 * for `AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE`). MUST NEVER change once
 * real data exists.
 */
const TASK_AUTONOMY_SETTING_UUID_NAMESPACE = '7e2f9c14-3a5d-4b8e-9f21-6c8a0d4e2b77';

/**
 * A field-for-field local copy of `@luminaos/agent-runtime`'s
 * `AutonomyTier`/`TaskAutonomySetting` (this PR's own domain types, declared
 * elsewhere in this same PR) -- declared locally rather than imported,
 * mirroring `agent-permission-manifests.service.integration.test.ts`'s
 * `AgentPermissionManifestContract` convention: importing a VALUE (not just
 * a type) that doesn't exist on disk yet would itself be an unresolved-
 * module error at runtime, cascading into unrelated lint/import noise across
 * this whole file. `'reconfigureAgentPermissions'` (the one
 * `AUTONOMY_GOVERNANCE_FLOOR` member, ADR-0039 Karar c) is likewise inlined
 * as a literal below rather than imported.
 */
type AutonomyTierContract = 'propose' | 'approve_and_act' | 'act_and_notify';

interface TaskAutonomySettingContract {
  id: string;
  workspaceId: string;
  actionType: string;
  tier: AutonomyTierContract;
  updatedBy: Actor;
  updatedAt: Date;
}

interface AutonomyTierSettingsServiceLike {
  set(
    workspaceId: string,
    actionType: string,
    tier: AutonomyTierContract,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<TaskAutonomySettingContract>;
  get(workspaceId: string, actionType: string): Promise<TaskAutonomySettingContract | null>;
  list(workspaceId: string, callerRole: MembershipRole): Promise<TaskAutonomySettingContract[]>;
  resolveTier(workspaceId: string, actionType: string): Promise<AutonomyTierContract>;
}

type AutonomyTierSettingsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AutonomyTierSettingsServiceLike;

const GOVERNANCE_FLOOR_ACTION_TYPE = 'reconfigureAgentPermissions';

describe('F3-T5 PR1 (RED step): AutonomyTierSettingsService — event-sourced, per-(workspaceId, actionType) autonomy tier setting (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: AutonomyTierSettingsServiceLike;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Imported dynamically, not statically at the top of this file, per the
    // established convention for "does not exist yet" RED-step service
    // modules (`agent-permission-manifests.service.integration.test.ts`).
    const serviceModule: unknown = await import('./autonomy-tier-settings.service.js');
    const AutonomyTierSettingsServiceCtor = (
      serviceModule as { AutonomyTierSettingsService: AutonomyTierSettingsServiceConstructor }
    ).AutonomyTierSettingsService;

    service = new AutonomyTierSettingsServiceCtor(db, eventStore, projectionRunner);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `task-autonomy-setting-test-workspace-${String(workspaceCounter)}`,
        slug: `task-autonomy-setting-test-workspace-${String(workspaceCounter)}`,
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

  it('1. set by an admin succeeds, returns the setting with expected fields, updatedBy is the real caller actor', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    const setting = await service.set(workspaceId, 'createTask', 'approve_and_act', actor, 'admin');

    expect(setting.id).toBeDefined();
    expect(typeof setting.id).toBe('string');
    expect(setting.workspaceId).toBe(workspaceId);
    expect(setting.actionType).toBe('createTask');
    expect(setting.tier).toBe('approve_and_act');
    expect(setting.updatedBy).toEqual({ type: 'user', id: actor.id });
    expect(setting.updatedAt).toBeDefined();
  });

  it('2. set by a "member" (not admin) throws ForbiddenError', async () => {
    const workspaceId = await createWorkspace();

    await expect(
      service.set(workspaceId, 'createTask', 'approve_and_act', fakeActor(), 'member'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('3. governance floor: set for "reconfigureAgentPermissions" to a non-propose tier throws ForbiddenError EVEN for an admin caller', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = fakeActor();

    await expect(
      service.set(
        workspaceId,
        GOVERNANCE_FLOOR_ACTION_TYPE,
        'approve_and_act',
        adminActor,
        'admin',
      ),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      service.set(workspaceId, GOVERNANCE_FLOOR_ACTION_TYPE, 'act_and_notify', adminActor, 'admin'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('3b. governance floor: set for "reconfigureAgentPermissions" to "propose" (the already-default value) is ALLOWED for an admin caller', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = fakeActor();

    const setting = await service.set(
      workspaceId,
      GOVERNANCE_FLOOR_ACTION_TYPE,
      'propose',
      adminActor,
      'admin',
    );

    expect(setting.actionType).toBe(GOVERNANCE_FLOOR_ACTION_TYPE);
    expect(setting.tier).toBe('propose');
  });

  it('4. resolveTier for an action type with no setting at all returns the fail-safe default "propose"', async () => {
    const workspaceId = await createWorkspace();

    const tier = await service.resolveTier(workspaceId, 'neverConfiguredActionType');

    expect(tier).toBe('propose');
  });

  it('5. resolveTier after a real set call returns the set tier', async () => {
    const workspaceId = await createWorkspace();

    await service.set(workspaceId, 'createTask', 'act_and_notify', fakeActor(), 'admin');

    const tier = await service.resolveTier(workspaceId, 'createTask');
    expect(tier).toBe('act_and_notify');
  });

  it('6. list is callable by a "member" (no throw) and returns settings for that workspace', async () => {
    const workspaceId = await createWorkspace();
    await service.set(workspaceId, 'createTask', 'approve_and_act', fakeActor(), 'admin');

    const settings = await service.list(workspaceId, 'member');
    expect(settings.some((s) => s.actionType === 'createTask')).toBe(true);
  });

  it('7. list by a "guest" (below member) throws ForbiddenError', async () => {
    const workspaceId = await createWorkspace();

    await expect(service.list(workspaceId, 'guest')).rejects.toThrow(ForbiddenError);
  });

  it("8. cross-workspace isolation: a setting set in workspace A does not appear in workspace B's list, and resolveTier against workspace B still returns the fail-safe 'propose' default", async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();

    await service.set(workspaceIdA, 'createTask', 'act_and_notify', fakeActor(), 'admin');

    const listInB = await service.list(workspaceIdB, 'member');
    expect(listInB.some((s) => s.actionType === 'createTask')).toBe(false);

    const tierInB = await service.resolveTier(workspaceIdB, 'createTask');
    expect(tierInB).toBe('propose');
  });

  it('9. set called twice for the SAME (workspaceId, actionType) is an UPSERT -- second call wins, exactly one row for that actionType', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await service.set(workspaceId, 'createTask', 'approve_and_act', actor, 'admin');
    const second = await service.set(workspaceId, 'createTask', 'act_and_notify', actor, 'admin');

    expect(second.tier).toBe('act_and_notify');

    const settings = await service.list(workspaceId, 'member');
    const matching = settings.filter((s) => s.actionType === 'createTask');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.tier).toBe('act_and_notify');
  });

  it('10. event-log visibility: set appends a TaskAutonomyTierSet event to the deterministic per-(workspaceId, actionType) stream, with the real calling actor', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await service.set(workspaceId, 'createTask', 'approve_and_act', actor, 'admin');

    const expectedStreamId = deriveDeterministicUuid(
      TASK_AUTONOMY_SETTING_UUID_NAMESPACE,
      `${workspaceId}:createTask`,
    );

    const streamEvents: StoredEvent[] = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.type).toBe('TaskAutonomyTierSet');
    expect(streamEvents[0]?.actor).toEqual({ type: 'user', id: actor.id });
    expect(streamEvents[0]?.payload['actionType']).toBe('createTask');
    expect(streamEvents[0]?.payload['tier']).toBe('approve_and_act');
  });
});
