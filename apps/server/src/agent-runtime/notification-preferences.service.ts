import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { agentNotificationPreferenceSetPayloadSchema } from '@luminaos/agent-runtime';
import type { NotificationPreference, QuietHoursWindow } from '@luminaos/agent-runtime';
import { AppError, ForbiddenError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';
import { deriveDeterministicUuid } from '@luminaos/shared/server';

import { NotificationPreferenceProjection } from './notification-preferences.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agentNotificationPreferences } from '../db/schema/agent-notification-preferences.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const NOTIFICATION_PREFERENCE_STREAM_TYPE = 'agent-notification-preference';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspaceId, userId)
 * notification-preference streamIds. MUST NEVER CHANGE once real data
 * exists — mirrors `TASK_AUTONOMY_SETTING_UUID_NAMESPACE`'s identical
 * reasoning. MUST match the literal pinned in
 * `notification-preferences.service.integration.test.ts`.
 */
export const NOTIFICATION_PREFERENCE_UUID_NAMESPACE = '9d4b6a3e-2c7f-4e1a-8b90-5f3d7c1e6a42';

export interface SetNotificationPreferenceInput {
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
}

type NotificationPreferenceRow = typeof agentNotificationPreferences.$inferSelect;

/**
 * Signals a database invariant violation (an upsert that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors
 * `AutonomyTierSettingsService`'s `UnexpectedQueryResultError` pattern.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

function toNotificationPreference(row: NotificationPreferenceRow): NotificationPreference {
  const quietHours: QuietHoursWindow | null =
    row.quietHoursStartHourUtc === null || row.quietHoursEndHourUtc === null
      ? null
      : { startHourUtc: row.quietHoursStartHourUtc, endHourUtc: row.quietHoursEndHourUtc };

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    notificationBudgetPerWindow: row.notificationBudgetPerWindow,
    quietHours,
    updatedAt: row.updatedAt,
  };
}

/**
 * F3-T13 PR1 (ADR-0047 Karar a/b/i): `NotificationPreferencesService`, an
 * event-sourced, per-`(workspaceId, userId)` personal notification
 * preference — structurally the same shape as `AutonomyTierSettingsService`
 * (own `Projection` instance, constructor-injected
 * `DATABASE_CONNECTION`/`EventStoreService`/`ProjectionRunner`, deterministic
 * per-key `streamId`, upsert-on-write), but with a STRICTER, self-only-with-
 * NO-admin-exception `set()` RBAC (ADR-0047 Karar i — deliberately NOT
 * `direct-messages.service.ts`'s admin-can-write-for-others pattern) and a
 * self-OR-admin `get()` RBAC (mirrors `direct-messages.service.ts`'s
 * `list()` read-pattern exactly).
 */
@Injectable()
export class NotificationPreferencesService {
  private readonly projection = new NotificationPreferenceProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  /**
   * Self-only, NO admin exception at all (ADR-0047 Karar i) — `actor.id`
   * must equal `userId` for EVERY caller, admin included.
   */
  async set(
    workspaceId: string,
    userId: string,
    prefs: SetNotificationPreferenceInput,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<NotificationPreference> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    if (actor.id !== userId) {
      throw new ForbiddenError();
    }

    const payload = agentNotificationPreferenceSetPayloadSchema.parse({
      notificationBudgetPerWindow: prefs.notificationBudgetPerWindow,
      quietHours: prefs.quietHours,
    });

    const streamId = this.streamIdFor(workspaceId, userId);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: NOTIFICATION_PREFERENCE_STREAM_TYPE,
      workspaceId,
      type: 'AgentNotificationPreferenceSet',
      payload,
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.resolvePreference(workspaceId, userId);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back notification preference immediately after setting it.',
      );
    }

    return current;
  }

  /**
   * Self OR admin+ (ADR-0047 Karar i, mirrors `DirectMessagesService.list`'s
   * read pattern exactly).
   */
  async get(
    workspaceId: string,
    userId: string,
    requestingUserId: string,
    callerRole: MembershipRole,
  ): Promise<NotificationPreference | null> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    if (requestingUserId !== userId && !hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    return this.resolvePreference(workspaceId, userId);
  }

  /**
   * NO RBAC parameter at all (ADR-0047 Karar b/i) — an internal read-point,
   * mirrors `AutonomyTierSettingsService.get`'s convention. Returns `null`
   * when no row exists for `(workspaceId, userId)` — the governor (PR2's
   * scope) treats a `null` return as "apply no budget/quiet-hours
   * restriction at all" (fail-open).
   */
  async resolvePreference(
    workspaceId: string,
    userId: string,
  ): Promise<NotificationPreference | null> {
    const [row] = await this.db
      .select()
      .from(agentNotificationPreferences)
      .where(
        and(
          eq(agentNotificationPreferences.workspaceId, workspaceId),
          eq(agentNotificationPreferences.userId, userId),
        ),
      )
      .limit(1);

    return row ? toNotificationPreference(row) : null;
  }

  private streamIdFor(workspaceId: string, userId: string): string {
    return deriveDeterministicUuid(
      NOTIFICATION_PREFERENCE_UUID_NAMESPACE,
      `${workspaceId}:${userId}`,
    );
  }
}
