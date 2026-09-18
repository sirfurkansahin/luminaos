import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';
import { deriveDeterministicUuid } from '@luminaos/shared/server';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T13 PR1 (RED step), ADR-0047 Karar (a)/(b)/(i) —
 * `NotificationPreferencesService`: event-sourced, `(workspaceId, userId)`
 * personal preference, mirroring `AutonomyTierSettingsService`'s exact
 * shape (own `Projection` instance, constructor-injected
 * `DATABASE_CONNECTION`/`EventStoreService`/`ProjectionRunner`, deterministic
 * per-key `streamId`, upsert-on-write) but with a STRICTER, self-only-with-
 * NO-admin-exception `set()` RBAC (ADR-0047 Karar i — deliberately NOT
 * `direct-messages.service.ts`'s admin-can-write-for-others pattern) and a
 * self-OR-admin `get()` RBAC (mirrors `direct-messages.service.ts`'s
 * `list()` read-pattern exactly).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./notification-preferences.service.ts` does
 * not exist at all, so the dynamic `import('./notification-preferences.
 * service.js')` call inside `beforeAll` REJECTS ("Cannot find module"),
 * failing every `it` in this file — mirrors `autonomy-tier-settings.service.
 * integration.test.ts`'s own documented "service doesn't exist yet" red
 * state. `agent_notification_preferences` (schema + migration `0046_*`,
 * also not yet on disk) is likewise expected missing — this file's
 * `beforeAll` will fail at `runMigrations` resolving no new migration, or at
 * the dynamic import, whichever `implementer` lands first; either is an
 * acceptable RED failure mode, NOT a bug in this test file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) — mirrors
 * `autonomy-tier-settings.service.integration.test.ts`'s lightweight
 * "direct `new EventStoreService(db)` / `new ProjectionRunner(db,
 * eventStore)`, no full Nest app boot" shape.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `NotificationPreferencesService(db, eventStore, projectionRunner)`:
 *   - `set(workspaceId, userId, prefs: {notificationBudgetPerWindow,
 *     quietHours}, actor, callerRole): Promise<NotificationPreference>` --
 *     member+ (else `ForbiddenError`) AND `actor.id === userId` REQUIRED --
 *     `actor.id !== userId` throws `ForbiddenError` for EVERY caller,
 *     INCLUDING an admin (ADR-0047 Karar i, no admin exception at all, the
 *     deliberate opposite of `direct-messages.service.ts`'s `send`/`list`
 *     write-side precedent). UPSERTS on `(workspaceId, userId)` (second
 *     `set` call for the same pair wins, no second row). Writes
 *     `AgentNotificationPreferenceSet` to a deterministic per-`(workspaceId,
 *     userId)` stream.
 *   - `get(workspaceId, userId, requestingUserId, callerRole):
 *     Promise<NotificationPreference | null>` -- member+ (else
 *     `ForbiddenError`) AND (`requestingUserId === userId` OR admin+) --
 *     else `ForbiddenError`. Returns `null` if no row exists for that
 *     `(workspaceId, userId)`. An admin caller MAY read a different user's
 *     preference (mirrors `direct-messages.service.ts`'s `list()` read
 *     pattern).
 *   - `resolvePreference(workspaceId, userId): Promise<NotificationPreference
 *     | null>` -- NO RBAC parameter at all, internal read-point (mirrors
 *     `AutonomyTierSettingsService.get`'s no-RBAC convention). Returns
 *     `null` when no row exists (ADR-0047 Karar b, fail-open — the governor,
 *     PR2's scope, treats a `null` return as "apply no budget/quiet-hours
 *     restriction at all").
 *
 * Deterministic per-`(workspaceId, userId)` `streamId` derivation mirrors
 * `AutonomyTierSettingsService.streamIdFor` exactly -- `deriveDeterministic
 * Uuid(NAMESPACE, `${workspaceId}:${userId}`)`. A fixed, arbitrary namespace
 * UUID is pinned below as `NOTIFICATION_PREFERENCE_UUID_NAMESPACE`;
 * implementer's own service-side constant of the same name/value is what
 * the event-log-visibility test independently verifies against.
 * ============================================================================
 */

/**
 * Pinned as this test file's OWN contract value -- implementer's
 * `notification-preferences.service.ts` MUST use this EXACT literal as its
 * `NOTIFICATION_PREFERENCE_UUID_NAMESPACE` constant (mirrors
 * `autonomy-tier-settings.service.integration.test.ts`'s identical
 * convention). MUST NEVER change once real data exists.
 */
const NOTIFICATION_PREFERENCE_UUID_NAMESPACE = '9d4b6a3e-2c7f-4e1a-8b90-5f3d7c1e6a42';

/**
 * A field-for-field local copy of `@luminaos/agent-runtime`'s
 * `QuietHoursWindow`/`NotificationPreference` (this PR's own domain types,
 * declared elsewhere in this same PR) -- declared locally rather than
 * imported, mirroring `autonomy-tier-settings.service.integration.test.ts`'s
 * `TaskAutonomySettingContract` convention: importing a VALUE that doesn't
 * exist on disk yet would itself cascade unrelated import-resolution noise
 * across this whole file.
 */
interface QuietHoursWindowContract {
  startHourUtc: number;
  endHourUtc: number;
}

interface NotificationPreferenceContract {
  id: string;
  workspaceId: string;
  userId: string;
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindowContract | null;
  updatedAt: Date;
}

interface SetNotificationPreferenceInputContract {
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindowContract | null;
}

interface NotificationPreferencesServiceLike {
  set(
    workspaceId: string,
    userId: string,
    prefs: SetNotificationPreferenceInputContract,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<NotificationPreferenceContract>;
  get(
    workspaceId: string,
    userId: string,
    requestingUserId: string,
    callerRole: MembershipRole,
  ): Promise<NotificationPreferenceContract | null>;
  resolvePreference(
    workspaceId: string,
    userId: string,
  ): Promise<NotificationPreferenceContract | null>;
}

type NotificationPreferencesServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => NotificationPreferencesServiceLike;

describe('F3-T13 PR1 (RED step): NotificationPreferencesService — event-sourced, per-(workspaceId, userId) personal notification preference (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: NotificationPreferencesServiceLike;
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
    // modules (`autonomy-tier-settings.service.integration.test.ts`).
    const serviceModule: unknown = await import('./notification-preferences.service.js');
    const NotificationPreferencesServiceCtor = (
      serviceModule as {
        NotificationPreferencesService: NotificationPreferencesServiceConstructor;
      }
    ).NotificationPreferencesService;

    service = new NotificationPreferencesServiceCtor(db, eventStore, projectionRunner);
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
        name: `notification-preference-test-workspace-${String(workspaceCounter)}`,
        slug: `notification-preference-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  function fakeUserId(): string {
    return randomUUID();
  }

  function fakePrefs(
    overrides: Partial<SetNotificationPreferenceInputContract> = {},
  ): SetNotificationPreferenceInputContract {
    return {
      notificationBudgetPerWindow: 10,
      quietHours: { startHourUtc: 22, endHourUtc: 7 },
      ...overrides,
    };
  }

  it('1. resolvePreference returns null when no row exists at all (fail-open, ADR-0047 Karar b)', async () => {
    const workspaceId = await createWorkspace();

    const preference = await service.resolvePreference(workspaceId, fakeUserId());

    expect(preference).toBeNull();
  });

  it('2. set by the SAME user (actor.id === userId) with member role succeeds, returns the setting with expected fields', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();
    const actor: Actor = { type: 'user', id: userId };

    const preference = await service.set(workspaceId, userId, fakePrefs(), actor, 'member');

    expect(preference.id).toBeDefined();
    expect(typeof preference.id).toBe('string');
    expect(preference.workspaceId).toBe(workspaceId);
    expect(preference.userId).toBe(userId);
    expect(preference.notificationBudgetPerWindow).toBe(10);
    expect(preference.quietHours).toEqual({ startHourUtc: 22, endHourUtc: 7 });
    expect(preference.updatedAt).toBeDefined();
  });

  it('3. set with quietHours: null succeeds and round-trips as null', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();
    const actor: Actor = { type: 'user', id: userId };

    const preference = await service.set(
      workspaceId,
      userId,
      fakePrefs({ quietHours: null }),
      actor,
      'member',
    );

    expect(preference.quietHours).toBeNull();
  });

  it('4. set throws ForbiddenError when actor.id !== userId, EVEN for an admin caller (ADR-0047 Karar i, no admin exception at all)', async () => {
    const workspaceId = await createWorkspace();
    const targetUserId = fakeUserId();
    const adminActor: Actor = { type: 'user', id: fakeUserId() };

    await expect(
      service.set(workspaceId, targetUserId, fakePrefs(), adminActor, 'admin'),
    ).rejects.toThrow(ForbiddenError);

    // Confirm nothing was written for the target user.
    const preference = await service.resolvePreference(workspaceId, targetUserId);
    expect(preference).toBeNull();
  });

  it('5. set throws ForbiddenError when actor.id !== userId for a non-admin caller too', async () => {
    const workspaceId = await createWorkspace();
    const targetUserId = fakeUserId();
    const otherActor: Actor = { type: 'user', id: fakeUserId() };

    await expect(
      service.set(workspaceId, targetUserId, fakePrefs(), otherActor, 'member'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('6. set throws ForbiddenError when the caller is below "member" (guest), even though actor.id === userId', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();
    const actor: Actor = { type: 'user', id: userId };

    await expect(service.set(workspaceId, userId, fakePrefs(), actor, 'guest')).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('7. set called twice for the SAME (workspaceId, userId) is an UPSERT -- second call wins, exactly one row', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();
    const actor: Actor = { type: 'user', id: userId };

    await service.set(
      workspaceId,
      userId,
      fakePrefs({ notificationBudgetPerWindow: 5 }),
      actor,
      'member',
    );
    const second = await service.set(
      workspaceId,
      userId,
      fakePrefs({ notificationBudgetPerWindow: 20 }),
      actor,
      'member',
    );

    expect(second.notificationBudgetPerWindow).toBe(20);

    const resolved = await service.resolvePreference(workspaceId, userId);
    expect(resolved?.notificationBudgetPerWindow).toBe(20);
  });

  it('8. get by the SAME user (requestingUserId === userId) succeeds and returns the preference', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();
    const actor: Actor = { type: 'user', id: userId };
    await service.set(workspaceId, userId, fakePrefs(), actor, 'member');

    const preference = await service.get(workspaceId, userId, userId, 'member');

    expect(preference?.userId).toBe(userId);
  });

  it("9. get by a DIFFERENT, non-admin member requesting someone else's preference throws ForbiddenError", async () => {
    const workspaceId = await createWorkspace();
    const ownerUserId = fakeUserId();
    const otherUserId = fakeUserId();
    await service.set(
      workspaceId,
      ownerUserId,
      fakePrefs(),
      { type: 'user', id: ownerUserId },
      'member',
    );

    await expect(service.get(workspaceId, ownerUserId, otherUserId, 'member')).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("10. get by an admin requesting a DIFFERENT user's preference succeeds (admin oversight read, ADR-0047 Karar i)", async () => {
    const workspaceId = await createWorkspace();
    const ownerUserId = fakeUserId();
    const adminUserId = fakeUserId();
    await service.set(
      workspaceId,
      ownerUserId,
      fakePrefs(),
      { type: 'user', id: ownerUserId },
      'member',
    );

    const preference = await service.get(workspaceId, ownerUserId, adminUserId, 'admin');

    expect(preference?.userId).toBe(ownerUserId);
  });

  it('11. get by a "guest" (below member) throws ForbiddenError even for their own preference', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();

    await expect(service.get(workspaceId, userId, userId, 'guest')).rejects.toThrow(ForbiddenError);
  });

  it('12. get returns null when the user has no preference row, for a self-read', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();

    const preference = await service.get(workspaceId, userId, userId, 'member');

    expect(preference).toBeNull();
  });

  it('13. cross-workspace isolation: a preference set in workspace A is not visible via resolvePreference in workspace B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const userId = fakeUserId();

    await service.set(workspaceIdA, userId, fakePrefs(), { type: 'user', id: userId }, 'member');

    const preferenceInB = await service.resolvePreference(workspaceIdB, userId);
    expect(preferenceInB).toBeNull();
  });

  it('14. event-log visibility: set appends an AgentNotificationPreferenceSet event to the deterministic per-(workspaceId, userId) stream, with the real calling actor', async () => {
    const workspaceId = await createWorkspace();
    const userId = fakeUserId();
    const actor: Actor = { type: 'user', id: userId };

    await service.set(workspaceId, userId, fakePrefs(), actor, 'member');

    const expectedStreamId = deriveDeterministicUuid(
      NOTIFICATION_PREFERENCE_UUID_NAMESPACE,
      `${workspaceId}:${userId}`,
    );

    const streamEvents: StoredEvent[] = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.type).toBe('AgentNotificationPreferenceSet');
    expect(streamEvents[0]?.actor).toEqual({ type: 'user', id: userId });
  });
});
