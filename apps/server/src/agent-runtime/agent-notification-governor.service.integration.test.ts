import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Actor } from '@luminaos/shared';

import { AutonomyTierSettingsService } from './autonomy-tier-settings.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { agentNotificationDeliveries } from '../db/schema/agent-notification-deliveries.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';

/**
 * F3-T13 PR2 (RED step), ADR-0047 Karar (c)/(d)/(e)/(f) —
 * `AgentNotificationGovernorService`: the budget/quiet-hours GATE sitting in
 * front of `notifyAutonomousAction`'s existing `CommentsService.create` call
 * (`CommandsService`'s own wiring is covered separately by
 * `../commands/commands.service.notification-governor.integration.test.ts`
 * -- this file ONLY exercises the governor in isolation, via its own public
 * surface, exactly mirroring `notification-preferences.service.integration.
 * test.ts`'s "service in isolation, real Postgres, no Nest app boot" shape).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./agent-notification-governor.service.ts`
 * does not exist at all, so the dynamic `import('./agent-notification-
 * governor.service.js')` call inside `beforeAll` REJECTS ("Cannot find
 * module"), failing every `it` in this file. A SECOND, independent RED
 * cause once that file lands: `env.agentNotificationBudgetWindowMs` is ALSO
 * not yet defined in `../config/env.ts` (confirmed absent as of this
 * commit -- PR1 did not actually add it despite the spec listing it under
 * PR1's scope) -- if the governor reads it at all, `env.ts` will need this
 * field added as part of landing THIS file's contract; either failure mode
 * is expected and is NOT a bug in this test file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) -- same
 * lightweight "direct `new EventStoreService(db)` / `new ProjectionRunner(db,
 * eventStore)`, no full Nest app boot" shape as `notification-preferences.
 * service.integration.test.ts`. `AutonomyTierSettingsService`/
 * `NotificationPreferencesService` are BOTH already-merged, unchanged-shape
 * real classes -- constructed directly (not pulled via DI), same convention
 * as `commands.service.autonomy-dial.integration.test.ts`.
 *
 * `AGENT_NOTIFICATION_BUDGET_WINDOW_MS` is set to a generous `3_600_000`
 * (1 hour) for the WHOLE FILE, set BEFORE the dynamic import of the governor
 * module in `beforeAll` (mirrors `agent-resource-limits.service.integration.
 * test.ts`'s exact "every relevant `process.env.*` value set before the
 * dynamic import" convention) -- every scenario below completes in real
 * milliseconds, comfortably inside a 1-hour rolling window, so no test
 * needs to reason about the window itself expiring mid-test.
 *
 * "Current time" control: `isWithinQuietHours`/`guardAndDeliver`'s quiet-hour
 * branch is PINNED by this file to read the REAL wall-clock `Date` (ADR-0047
 * Karar h's code sketch calls `this.isWithinQuietHours(preference.
 * quietHours)` with a SINGLE argument -- no injectable "now" parameter) --
 * so every quiet-hours scenario below uses `vi.useFakeTimers({toFake:
 * ['Date']})` + `vi.setSystemTime(...)` to freeze ONLY `Date`/`Date.now()`,
 * deliberately leaving `setTimeout`/`setInterval` on REAL timers so the
 * Postgres driver's own real async I/O (connection handling, query
 * round-trips) is completely unaffected -- `vi.useRealTimers()` restores
 * normal time in `afterEach` for every test in this file, including ones
 * that never touch fake timers at all (harmless no-op in that case).
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `AgentNotificationGovernorService(db, eventStore, projectionRunner,
 * autonomyTierSettingsService, preferencesService)`:
 *   - `guardAndDeliver(workspaceId, actionType, sourceObjectId, deliver: () =>
 *     Promise<{commentId: string}>): Promise<void>` -- ADR-0047 Karar (h)'s
 *     own code sketch, verbatim:
 *       1. `autonomyTierSettingsService.get(workspaceId, actionType)` --
 *          `null` OR `updatedBy.type !== 'user'` -> FAIL-OPEN: calls
 *          `deliver()` and returns, WITHOUT ever calling `recordOutcome`
 *          (no `agent_notification_deliveries` row, no event at all --
 *          "bugünkü davranış AYNEN korunur" means no NEW tracking artifact
 *          either, ADR-0047 Karar b).
 *       2. Otherwise `recipientUserId = setting.updatedBy.id`;
 *          `preferencesService.resolvePreference(workspaceId,
 *          recipientUserId)` -- `null` -> SAME fail-open as step 1 (calls
 *          `deliver()`, returns, no `recordOutcome`).
 *       3. `isWithinQuietHours(preference.quietHours)` true -> `recordOutcome(
 *          ..., 'suppressed_quiet_hours')`, returns WITHOUT ever calling
 *          `deliver()`.
 *       4. `countDeliveredInWindow(workspaceId, recipientUserId) >=
 *          preference.notificationBudgetPerWindow` -> `recordOutcome(...,
 *          'suppressed_budget_exceeded')`, returns WITHOUT calling `deliver()`.
 *       5. Otherwise calls `deliver()`, then `recordOutcome(..., 'delivered',
 *          commentId)` with the `commentId` `deliver()` resolved to.
 *   - `countDeliveredInWindow(workspaceId, recipientUserId): Promise<number>`
 *     -- counts ONLY `outcome === 'delivered'` `agent_notification_deliveries`
 *     rows for `(workspaceId, recipientUserId)` within the trailing
 *     `env.agentNotificationBudgetWindowMs` window (ADR-0047 Karar d) --
 *     suppressed rows NEVER counted.
 *   - `isWithinQuietHours(quietHours: QuietHoursWindow | null): boolean` --
 *     `null` -> always `false`. Otherwise compares the REAL current
 *     `Date`'s UTC hour (`new Date().getUTCHours()`) against
 *     `[startHourUtc, endHourUtc)` (end EXCLUSIVE) for a non-wrapping window
 *     (`startHourUtc <= endHourUtc`), or `hour >= startHourUtc || hour <
 *     endHourUtc` for a WRAPPING window (`endHourUtc < startHourUtc`, e.g.
 *     22 -> 7) -- this file's own pinned boundary convention (ADR-0047
 *     Karar b only fixes the wrap SEMANTICS, not the exact inclusive/
 *     exclusive boundary; this test file pins the boundary the implementer
 *     must match).
 *   - `recordOutcome(workspaceId, recipientUserId, actionType,
 *     sourceObjectId, outcome, commentId?): Promise<void>` -- appends
 *     `AgentNotificationDelivered` (outcome `'delivered'`, `commentId`
 *     required) or `AgentNotificationSuppressed` (either suppressed outcome,
 *     `reason` derived from `outcome`, no `commentId`) to a BRAND-NEW,
 *     dedicated stream (`randomUUID()` streamId, mirrors
 *     `AgentResourceLimitsService.recordAgentAction`'s "record-per-fresh-
 *     stream" convention) then advances the `agent_notification_deliveries`
 *     projection.
 *   - `getUsageSummary(workspaceId, userId): Promise<{deliveredCountInWindow:
 *     number; overloaded: boolean; topActionType: {actionType: string;
 *     count: number} | null}>` -- `deliveredCountInWindow` is
 *     `countDeliveredInWindow`'s own value; `overloaded` is `true` iff
 *     `deliveredCountInWindow >= ` the user's `notificationBudgetPerWindow`
 *     (a user with NO preference row has no budget to exceed -- this file
 *     only exercises the "preference exists" branch); `topActionType` is
 *     computed ONLY from `outcome==='delivered'` rows, grouped by
 *     `actionType`, the single highest COUNT (ADR-0047 Karar f) -- ties are
 *     NOT exercised by this file (left to implementer's own tie-break,
 *     non-contentious per the ADR).
 * ============================================================================
 */

const AGENT_NOTIFICATION_BUDGET_WINDOW_MS = 3_600_000;

interface QuietHoursWindowContract {
  startHourUtc: number;
  endHourUtc: number;
}

interface UsageSummaryContract {
  deliveredCountInWindow: number;
  overloaded: boolean;
  topActionType: { actionType: string; count: number } | null;
}

type NotificationDeliveryOutcomeContract =
  'delivered' | 'suppressed_quiet_hours' | 'suppressed_budget_exceeded';

interface AgentNotificationGovernorServiceLike {
  guardAndDeliver(
    workspaceId: string,
    actionType: string,
    sourceObjectId: string,
    deliver: () => Promise<{ commentId: string }>,
  ): Promise<void>;
  countDeliveredInWindow(workspaceId: string, recipientUserId: string): Promise<number>;
  isWithinQuietHours(quietHours: QuietHoursWindowContract | null): boolean;
  recordOutcome(
    workspaceId: string,
    recipientUserId: string,
    actionType: string,
    sourceObjectId: string,
    outcome: NotificationDeliveryOutcomeContract,
    commentId?: string | null,
  ): Promise<void>;
  getUsageSummary(workspaceId: string, userId: string): Promise<UsageSummaryContract>;
}

type AgentNotificationGovernorServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  autonomyTierSettingsService: AutonomyTierSettingsService,
  preferencesService: NotificationPreferencesService,
) => AgentNotificationGovernorServiceLike;

/** Resolves to `{ commentId }` WITHOUT ever using `await` -- every fixture
 * below is deliberately a plain (non-`async`) function returning
 * `Promise.resolve(...)` so `@typescript-eslint/require-await` never fires;
 * these still satisfy `guardAndDeliver`'s `() => Promise<{commentId:
 * string}>` parameter type exactly. */
function resolvedDeliver(commentId: string = randomUUID()): () => Promise<{ commentId: string }> {
  return () => Promise.resolve({ commentId });
}

/** Same "no `await`, still `Promise<...>`-typed" shape as `resolvedDeliver`,
 * but also increments a caller-visible counter -- used everywhere a test
 * needs to assert whether `deliver()` was actually invoked. */
function countingDeliver(onCall: () => void): () => Promise<{ commentId: string }> {
  return () => {
    onCall();
    return Promise.resolve({ commentId: randomUUID() });
  };
}

/** Same as `countingDeliver`, but resolves to a CALLER-CHOSEN `commentId` --
 * used to assert `recordOutcome`'s `commentId` argument round-trips exactly
 * the value `deliver()` resolved to (ADR-0047 Karar h, final step). */
function countingDeliverWithId(
  onCall: () => void,
  commentId: string,
): () => Promise<{ commentId: string }> {
  return () => {
    onCall();
    return Promise.resolve({ commentId });
  };
}

describe('F3-T13 PR2 (RED step): AgentNotificationGovernorService — budget/quiet-hours gate (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let autonomyTierSettingsService: AutonomyTierSettingsService;
  let preferencesService: NotificationPreferencesService;
  let governor: AgentNotificationGovernorServiceLike;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;
    process.env.AGENT_NOTIFICATION_BUDGET_WINDOW_MS = String(AGENT_NOTIFICATION_BUDGET_WINDOW_MS);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);
    autonomyTierSettingsService = new AutonomyTierSettingsService(db, eventStore, projectionRunner);
    preferencesService = new NotificationPreferencesService(db, eventStore, projectionRunner);

    // Imported dynamically, not statically, per the established "does not
    // exist yet" RED-step service module convention.
    const governorModule: unknown = await import('./agent-notification-governor.service.js');
    const AgentNotificationGovernorServiceCtor = (
      governorModule as {
        AgentNotificationGovernorService: AgentNotificationGovernorServiceConstructor;
      }
    ).AgentNotificationGovernorService;

    governor = new AgentNotificationGovernorServiceCtor(
      db,
      eventStore,
      projectionRunner,
      autonomyTierSettingsService,
      preferencesService,
    );
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `notification-governor-test-workspace-${String(workspaceCounter)}`,
        slug: `notification-governor-test-workspace-${String(workspaceCounter)}`,
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

  /** A recipient with a real "act_and_notify"-tier setting `updatedBy` -- the ONLY way `guardAndDeliver` ever resolves a `recipientUserId`. */
  async function routeActionTypeToUser(
    workspaceId: string,
    actionType: string,
    recipientUserId: string,
  ): Promise<void> {
    const actor: Actor = { type: 'user', id: recipientUserId };
    await autonomyTierSettingsService.set(
      workspaceId,
      actionType,
      'act_and_notify',
      actor,
      'admin',
    );
  }

  async function setPreference(
    workspaceId: string,
    userId: string,
    notificationBudgetPerWindow: number,
    quietHours: QuietHoursWindowContract | null,
  ): Promise<void> {
    await preferencesService.set(
      workspaceId,
      userId,
      { notificationBudgetPerWindow, quietHours },
      { type: 'user', id: userId },
      'member',
    );
  }

  async function deliveryRows(workspaceId: string, recipientUserId: string) {
    const rows = await db
      .select()
      .from(agentNotificationDeliveries)
      .where(eq(agentNotificationDeliveries.workspaceId, workspaceId));
    return rows.filter((row) => row.recipientUserId === recipientUserId);
  }

  async function notificationEvents(workspaceId: string): Promise<StoredEvent[]> {
    const events = await eventStore.readByWorkspace(workspaceId, 0);
    return events.filter(
      (event) =>
        event.type === 'AgentNotificationDelivered' || event.type === 'AgentNotificationSuppressed',
    );
  }

  // =========================================================================
  // 1. Fail-open: no TaskAutonomySetting row at all.
  // =========================================================================

  it('1. fail-open: no TaskAutonomySetting row for actionType -> delivers unconditionally, no delivery record at all', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const sourceObjectId = randomUUID();
    let deliverCalls = 0;

    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(1);
    expect(await notificationEvents(workspaceId)).toHaveLength(0);
  });

  // =========================================================================
  // 2. Fail-open: no NotificationPreference row for the resolved recipient.
  // =========================================================================

  it('2. fail-open: TaskAutonomySetting exists with a real user updatedBy, but that user has no NotificationPreference row -> delivers unconditionally', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    const sourceObjectId = randomUUID();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);

    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(1);
    expect(await notificationEvents(workspaceId)).toHaveLength(0);
    expect(await deliveryRows(workspaceId, recipientUserId)).toHaveLength(0);
  });

  // =========================================================================
  // 3. Fail-open: updatedBy.type !== 'user'.
  // =========================================================================

  it("3. fail-open: TaskAutonomySetting's updatedBy.type is 'system' (not 'user') -> delivers unconditionally, even though a NotificationPreference row exists for that id", async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const sourceObjectId = randomUUID();
    const nonUserId = 'autonomy-dial';

    // Theoretical per ADR-0047 Karar c ("bir migration/seed-script tarafından
    // yazılmışsa") -- written directly with a non-'user' actor, which
    // `AutonomyTierSettingsService.set` does not itself forbid.
    await autonomyTierSettingsService.set(
      workspaceId,
      actionType,
      'act_and_notify',
      { type: 'system', id: nonUserId },
      'admin',
    );
    // Even a real preference row under the SAME id must be ignored, since
    // `updatedBy.type !== 'user'` short-circuits BEFORE any preference
    // lookup for this id is ever meaningful.
    await setPreference(workspaceId, nonUserId, 0, { startHourUtc: 0, endHourUtc: 23 });

    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(1);
    expect(await notificationEvents(workspaceId)).toHaveLength(0);
  });

  // =========================================================================
  // 4. Quiet-hours suppression -- non-wrapping window.
  // =========================================================================

  it('4. quiet hours (non-wrapping window, e.g. 2 -> 5 UTC): current hour inside the window suppresses delivery, deliver() never called, AgentNotificationSuppressed{reason:"quiet_hours"} recorded', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    const sourceObjectId = randomUUID();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);
    await setPreference(workspaceId, recipientUserId, 100, { startHourUtc: 2, endHourUtc: 5 });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T03:30:00.000Z')); // 03:30 UTC, inside [2,5)

    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(0);

    const rows = await deliveryRows(workspaceId, recipientUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('suppressed_quiet_hours');
    expect(rows[0]?.commentId).toBeNull();

    const events = await notificationEvents(workspaceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('AgentNotificationSuppressed');
    expect(events[0]?.payload['reason']).toBe('quiet_hours');
  });

  // =========================================================================
  // 5. Quiet-hours suppression -- wrap-past-midnight window.
  // =========================================================================

  it('5. quiet hours (wrap-past-midnight window, 22 -> 7 UTC): current hour in the LATE-NIGHT part (23) suppresses delivery', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    const sourceObjectId = randomUUID();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);
    await setPreference(workspaceId, recipientUserId, 100, { startHourUtc: 22, endHourUtc: 7 });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T23:15:00.000Z')); // 23:15 UTC

    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(0);
    const rows = await deliveryRows(workspaceId, recipientUserId);
    expect(rows.some((row) => row.outcome === 'suppressed_quiet_hours')).toBe(true);
  });

  it('6. quiet hours (wrap-past-midnight window, 22 -> 7 UTC): current hour in the EARLY-MORNING part (3) ALSO suppresses delivery', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    const sourceObjectId = randomUUID();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);
    await setPreference(workspaceId, recipientUserId, 100, { startHourUtc: 22, endHourUtc: 7 });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:45:00.000Z')); // 03:45 UTC

    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(0);
    const rows = await deliveryRows(workspaceId, recipientUserId);
    expect(rows.some((row) => row.outcome === 'suppressed_quiet_hours')).toBe(true);
  });

  it('7. quiet hours (wrap-past-midnight window, 22 -> 7 UTC): current hour OUTSIDE the window (e.g. 12:00 UTC) does NOT suppress', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    const sourceObjectId = randomUUID();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);
    await setPreference(workspaceId, recipientUserId, 100, { startHourUtc: 22, endHourUtc: 7 });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z')); // 12:00 UTC, outside [22,7)

    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      sourceObjectId,
      countingDeliver(() => {
        deliverCalls += 1;
      }),
    );

    expect(deliverCalls).toBe(1);
  });

  // =========================================================================
  // 8. `isWithinQuietHours` exercised directly.
  // =========================================================================

  describe('8. isWithinQuietHours (direct, pure-ish contract)', () => {
    it('returns false for quietHours: null, regardless of current time', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T22:00:00.000Z'));
      expect(governor.isWithinQuietHours(null)).toBe(false);
    });

    it('non-wrapping window [2,5): boundary is start-inclusive, end-exclusive', () => {
      const window = { startHourUtc: 2, endHourUtc: 5 };

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(true);

      vi.setSystemTime(new Date('2026-01-01T04:59:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(true);

      vi.setSystemTime(new Date('2026-01-01T05:00:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(false);

      vi.setSystemTime(new Date('2026-01-01T01:59:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(false);
    });

    it('wrapping window [22,7): boundary is start-inclusive, end-exclusive across midnight', () => {
      const window = { startHourUtc: 22, endHourUtc: 7 };

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T22:00:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(true);

      vi.setSystemTime(new Date('2026-01-01T06:59:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(true);

      vi.setSystemTime(new Date('2026-01-01T07:00:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(false);

      vi.setSystemTime(new Date('2026-01-01T21:59:00.000Z'));
      expect(governor.isWithinQuietHours(window)).toBe(false);
    });
  });

  // =========================================================================
  // 9. Budget-exceeded suppression.
  // =========================================================================

  it('9. budget exceeded: with notificationBudgetPerWindow: 1, the FIRST guardAndDeliver call delivers, the SECOND (same window) is suppressed_budget_exceeded and never calls deliver()', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);
    await setPreference(workspaceId, recipientUserId, 1, null);

    let firstDeliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      randomUUID(),
      countingDeliver(() => {
        firstDeliverCalls += 1;
      }),
    );
    expect(firstDeliverCalls).toBe(1);

    let secondDeliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      randomUUID(),
      countingDeliver(() => {
        secondDeliverCalls += 1;
      }),
    );
    expect(secondDeliverCalls).toBe(0);

    const rows = await deliveryRows(workspaceId, recipientUserId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.outcome === 'delivered')).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === 'suppressed_budget_exceeded')).toHaveLength(1);
  });

  // =========================================================================
  // 10. Successful delivery + the context-switch counter excludes suppressed.
  // =========================================================================

  it('10. successful delivery records AgentNotificationDelivered with the real commentId, AND getUsageSummary().deliveredCountInWindow counts ONLY the delivered one (not a prior suppressed one)', async () => {
    const workspaceId = await createWorkspace();
    const actionType = 'createTask';
    const recipientUserId = fakeUserId();
    await routeActionTypeToUser(workspaceId, actionType, recipientUserId);
    await setPreference(workspaceId, recipientUserId, 10, { startHourUtc: 2, endHourUtc: 5 });

    // Call #1: frozen inside the quiet-hours window -> suppressed.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T03:00:00.000Z'));
    await governor.guardAndDeliver(workspaceId, actionType, randomUUID(), resolvedDeliver());

    // Call #2: frozen OUTSIDE the quiet-hours window -> delivered.
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const deliveredCommentId = randomUUID();
    let deliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      actionType,
      randomUUID(),
      countingDeliverWithId(() => {
        deliverCalls += 1;
      }, deliveredCommentId),
    );
    expect(deliverCalls).toBe(1);

    const rows = await deliveryRows(workspaceId, recipientUserId);
    expect(rows).toHaveLength(2);
    const deliveredRow = rows.find((row) => row.outcome === 'delivered');
    expect(deliveredRow?.commentId).toBe(deliveredCommentId);

    const count = await governor.countDeliveredInWindow(workspaceId, recipientUserId);
    expect(count).toBe(1);

    const summary = await governor.getUsageSummary(workspaceId, recipientUserId);
    expect(summary.deliveredCountInWindow).toBe(1);
  });

  // =========================================================================
  // 11. recordOutcome exercised directly.
  // =========================================================================

  describe('11. recordOutcome (direct)', () => {
    it("outcome: 'delivered' persists a row with the given commentId and appends AgentNotificationDelivered", async () => {
      const workspaceId = await createWorkspace();
      const recipientUserId = fakeUserId();
      const actionType = 'createTask';
      const sourceObjectId = randomUUID();
      const commentId = randomUUID();

      await governor.recordOutcome(
        workspaceId,
        recipientUserId,
        actionType,
        sourceObjectId,
        'delivered',
        commentId,
      );

      const rows = await deliveryRows(workspaceId, recipientUserId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('delivered');
      expect(rows[0]?.commentId).toBe(commentId);
      expect(rows[0]?.actionType).toBe(actionType);
      expect(rows[0]?.sourceObjectId).toBe(sourceObjectId);

      const events = await notificationEvents(workspaceId);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('AgentNotificationDelivered');
    });

    it("outcome: 'suppressed_budget_exceeded' persists a row with commentId null and appends AgentNotificationSuppressed{reason:'budget_exceeded'}", async () => {
      const workspaceId = await createWorkspace();
      const recipientUserId = fakeUserId();
      const actionType = 'createTask';
      const sourceObjectId = randomUUID();

      await governor.recordOutcome(
        workspaceId,
        recipientUserId,
        actionType,
        sourceObjectId,
        'suppressed_budget_exceeded',
      );

      const rows = await deliveryRows(workspaceId, recipientUserId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('suppressed_budget_exceeded');
      expect(rows[0]?.commentId).toBeNull();

      const events = await notificationEvents(workspaceId);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('AgentNotificationSuppressed');
      expect(events[0]?.payload['reason']).toBe('budget_exceeded');
    });
  });

  // =========================================================================
  // 12. getUsageSummary: overloaded + topActionType, computed live.
  // =========================================================================

  it('12. getUsageSummary computes overloaded/topActionType LIVE from delivered rows only, across multiple actionTypes routed to the SAME recipient', async () => {
    const workspaceId = await createWorkspace();
    const recipientUserId = fakeUserId();
    await routeActionTypeToUser(workspaceId, 'createTask', recipientUserId);
    await routeActionTypeToUser(workspaceId, 'sendEmail', recipientUserId);
    // Aggregate budget of 3 across BOTH actionTypes (ADR-0047 Karar f: one
    // agrege bütçe, actionType-başına DEĞİL).
    await setPreference(workspaceId, recipientUserId, 3, null);

    // 2 delivered createTask notifications.
    await governor.guardAndDeliver(workspaceId, 'createTask', randomUUID(), resolvedDeliver());
    await governor.guardAndDeliver(workspaceId, 'createTask', randomUUID(), resolvedDeliver());
    // 1 delivered sendEmail notification -> total delivered = 3 = budget.
    await governor.guardAndDeliver(workspaceId, 'sendEmail', randomUUID(), resolvedDeliver());

    // A 4th call (createTask again) must now be suppressed -- budget spent.
    let fourthDeliverCalls = 0;
    await governor.guardAndDeliver(
      workspaceId,
      'createTask',
      randomUUID(),
      countingDeliver(() => {
        fourthDeliverCalls += 1;
      }),
    );
    expect(fourthDeliverCalls).toBe(0);

    const summary = await governor.getUsageSummary(workspaceId, recipientUserId);

    expect(summary.deliveredCountInWindow).toBe(3);
    expect(summary.overloaded).toBe(true);
    expect(summary.topActionType).toEqual({ actionType: 'createTask', count: 2 });
  });

  it('13. getUsageSummary: overloaded is false while deliveredCountInWindow stays under the budget', async () => {
    const workspaceId = await createWorkspace();
    const recipientUserId = fakeUserId();
    await routeActionTypeToUser(workspaceId, 'createTask', recipientUserId);
    await setPreference(workspaceId, recipientUserId, 5, null);

    await governor.guardAndDeliver(workspaceId, 'createTask', randomUUID(), resolvedDeliver());

    const summary = await governor.getUsageSummary(workspaceId, recipientUserId);
    expect(summary.deliveredCountInWindow).toBe(1);
    expect(summary.overloaded).toBe(false);
  });
});
