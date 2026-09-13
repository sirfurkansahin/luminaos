import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';

import {
  agentNotificationDeliveredPayloadSchema,
  agentNotificationSuppressedPayloadSchema,
} from '@luminaos/agent-runtime';
import type { NotificationDeliveryOutcome, QuietHoursWindow } from '@luminaos/agent-runtime';
import type { NewDomainEvent } from '@luminaos/shared';

import { AgentNotificationDeliveriesProjection } from './agent-notification-deliveries.projection.js';
import { AutonomyTierSettingsService } from './autonomy-tier-settings.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agentNotificationDeliveries } from '../db/schema/agent-notification-deliveries.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/** The dedicated event-stream type for `AgentNotificationDelivered`/`AgentNotificationSuppressed` events -- one brand-new stream per recorded outcome, mirroring `AgentActionExecutionsProjection`'s `AGENT_ACTION_EXECUTION_STREAM_TYPE` "record-per-fresh-stream" convention (ADR-0047 Somut Şekiller). */
const NOTIFICATION_DELIVERY_STREAM_TYPE = 'agent-notification-delivery';

/**
 * The always-and-only actor recorded on every `AgentNotificationDelivered`/
 * `AgentNotificationSuppressed` event (ADR-0047 Karar h) -- this is a
 * teslimat-KARARI, not a user- or agent-authored action, so it is authored by
 * the governor itself, distinct from `AUTONOMY_DIAL_ACTOR`
 * (`../commands/commands.service.ts`) which represents the ORIGINAL
 * autonomous action's own actor.
 */
const NOTIFICATION_GOVERNOR_ACTOR = { type: 'system', id: 'notification-governor' } as const;

export interface NotificationUsageSummary {
  deliveredCountInWindow: number;
  overloaded: boolean;
  topActionType: { actionType: string; count: number } | null;
}

/**
 * F3-T13 PR2 (ADR-0047 Karar c/d/e/f/h): `AgentNotificationGovernorService` --
 * the budget/quiet-hours GATE sitting in front of `CommandsService.
 * notifyAutonomousAction`'s existing `CommentsService.create` reply-comment
 * call. Structurally mirrors `AgentResourceLimitsService`'s "own `Projection`
 * instance, DB-backed live-count check, best-effort outcome recording"
 * shape, but its own "gate" (`guardAndDeliver`) never THROWS on a
 * budget/quiet-hours hit -- it simply skips the `deliver` callback (ADR-0047
 * Karar e: sessiz saatte/bütçe aşımında bastırılan bildirim TAMAMEN DÜŞER,
 * hiçbir hata fırlatılmaz).
 */
@Injectable()
export class AgentNotificationGovernorService {
  private readonly projection = new AgentNotificationDeliveriesProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly autonomyTierSettingsService: AutonomyTierSettingsService,
    private readonly preferencesService: NotificationPreferencesService,
  ) {}

  /**
   * ADR-0047 Karar (h)'s own code sketch, verbatim: resolves the recipient
   * from `AutonomyTierSettingsService.get(workspaceId, actionType).
   * updatedBy` (fail-open to unconditional delivery when there is no
   * setting, or its `updatedBy` is not a real user, Karar c), then a
   * `NotificationPreference` row for that recipient (fail-open again when
   * absent, Karar b), then gates on quiet-hours (Karar e) and the rolling
   * budget (Karar f) -- in THAT order, quiet-hours first. Exactly one of
   * `deliver()`/`recordOutcome(...)` combination happens per call: either
   * `deliver()` alone (both fail-open branches), `recordOutcome` alone
   * (either suppression), or `deliver()` followed by `recordOutcome(...,
   * 'delivered', commentId)`.
   */
  async guardAndDeliver(
    workspaceId: string,
    actionType: string,
    sourceObjectId: string,
    deliver: () => Promise<{ commentId: string }>,
  ): Promise<void> {
    const setting = await this.autonomyTierSettingsService.get(workspaceId, actionType);

    if (!setting || setting.updatedBy.type !== 'user') {
      await deliver();
      return;
    }

    const recipientUserId = setting.updatedBy.id;
    const preference = await this.preferencesService.resolvePreference(
      workspaceId,
      recipientUserId,
    );

    if (!preference) {
      await deliver();
      return;
    }

    if (this.isWithinQuietHours(preference.quietHours)) {
      await this.recordOutcome(
        workspaceId,
        recipientUserId,
        actionType,
        sourceObjectId,
        'suppressed_quiet_hours',
      );
      return;
    }

    const deliveredCount = await this.countDeliveredInWindow(workspaceId, recipientUserId);

    if (deliveredCount >= preference.notificationBudgetPerWindow) {
      await this.recordOutcome(
        workspaceId,
        recipientUserId,
        actionType,
        sourceObjectId,
        'suppressed_budget_exceeded',
      );
      return;
    }

    const { commentId } = await deliver();
    await this.recordOutcome(
      workspaceId,
      recipientUserId,
      actionType,
      sourceObjectId,
      'delivered',
      commentId,
    );
  }

  /**
   * `null` -> always `false` (no quiet hours configured). Otherwise compares
   * the REAL current `Date`'s UTC hour against `[startHourUtc, endHourUtc)`
   * (end EXCLUSIVE) -- a non-wrapping window (`startHourUtc <= endHourUtc`)
   * is a plain range check; a WRAPPING window (`endHourUtc < startHourUtc`,
   * e.g. 22 -> 7) is `hour >= startHourUtc || hour < endHourUtc` (ADR-0047
   * Karar b's wrap semantics).
   */
  isWithinQuietHours(quietHours: QuietHoursWindow | null): boolean {
    if (!quietHours) {
      return false;
    }

    const { startHourUtc, endHourUtc } = quietHours;
    const hour = new Date().getUTCHours();

    if (startHourUtc <= endHourUtc) {
      return hour >= startHourUtc && hour < endHourUtc;
    }

    return hour >= startHourUtc || hour < endHourUtc;
  }

  /**
   * Counts ONLY `outcome === 'delivered'` `agent_notification_deliveries`
   * rows for `(workspaceId, recipientUserId)` within the trailing
   * `env.agentNotificationBudgetWindowMs` window (ADR-0047 Karar d) --
   * suppressed rows are NEVER counted, mirroring
   * `AgentResourceLimitsService.assertActionRateNotExceeded`'s exact
   * "live COUNT query over a rolling window" shape.
   */
  async countDeliveredInWindow(workspaceId: string, recipientUserId: string): Promise<number> {
    const windowStart = new Date(Date.now() - env.agentNotificationBudgetWindowMs);

    const [row] = await this.db
      .select({ total: sql<string>`COUNT(*)` })
      .from(agentNotificationDeliveries)
      .where(
        and(
          eq(agentNotificationDeliveries.workspaceId, workspaceId),
          eq(agentNotificationDeliveries.recipientUserId, recipientUserId),
          eq(agentNotificationDeliveries.outcome, 'delivered'),
          gte(agentNotificationDeliveries.occurredAt, windowStart),
        ),
      );

    return Number(row?.total ?? 0);
  }

  /**
   * Appends `AgentNotificationDelivered` (outcome `'delivered'`, `commentId`
   * required) or `AgentNotificationSuppressed` (either suppressed outcome,
   * `reason` derived from `outcome`, no `commentId`) to a BRAND-NEW,
   * dedicated stream (`randomUUID()` streamId, mirrors
   * `AgentResourceLimitsService.recordAgentAction`'s "record-per-fresh-
   * stream" convention), then advances the `agent_notification_deliveries`
   * projection. Unlike `recordAgentAction`, this is NOT wrapped in a
   * try/catch here -- `CommandsService.notifyAutonomousAction`'s OWN
   * best-effort try/catch (ADR-0047 Karar h) already covers the entire
   * `guardAndDeliver` call, so double-wrapping would only hide a genuine
   * failure from that single call site without adding any real safety.
   */
  async recordOutcome(
    workspaceId: string,
    recipientUserId: string,
    actionType: string,
    sourceObjectId: string,
    outcome: NotificationDeliveryOutcome,
    commentId?: string | null,
  ): Promise<void> {
    const streamId = randomUUID();
    const occurredAt = new Date();

    const event: NewDomainEvent =
      outcome === 'delivered'
        ? {
            id: randomUUID(),
            streamType: NOTIFICATION_DELIVERY_STREAM_TYPE,
            workspaceId,
            type: 'AgentNotificationDelivered',
            payload: agentNotificationDeliveredPayloadSchema.parse({
              recipientUserId,
              actionType,
              sourceObjectId,
              commentId,
            }),
            actor: NOTIFICATION_GOVERNOR_ACTOR,
            occurredAt,
          }
        : {
            id: randomUUID(),
            streamType: NOTIFICATION_DELIVERY_STREAM_TYPE,
            workspaceId,
            type: 'AgentNotificationSuppressed',
            payload: agentNotificationSuppressedPayloadSchema.parse({
              recipientUserId,
              actionType,
              sourceObjectId,
              reason: outcome === 'suppressed_quiet_hours' ? 'quiet_hours' : 'budget_exceeded',
            }),
            actor: NOTIFICATION_GOVERNOR_ACTOR,
            occurredAt,
          };

    await this.eventStore.append(streamId, 0, [event]);
    await this.projectionRunner.catchUp(this.projection);
  }

  /**
   * `deliveredCountInWindow` is `countDeliveredInWindow`'s own value;
   * `overloaded` is `true` iff `deliveredCountInWindow >= ` the user's
   * `notificationBudgetPerWindow` (a user with no preference row has no
   * budget to exceed, so `overloaded` is always `false` for them);
   * `topActionType` is computed ONLY from `outcome==='delivered'` rows,
   * grouped by `actionType`, the single highest COUNT -- CANLI, no
   * persisted "signal" row (ADR-0047 Karar f).
   */
  async getUsageSummary(workspaceId: string, userId: string): Promise<NotificationUsageSummary> {
    const preference = await this.preferencesService.resolvePreference(workspaceId, userId);
    const deliveredCountInWindow = await this.countDeliveredInWindow(workspaceId, userId);
    const overloaded =
      preference !== null && deliveredCountInWindow >= preference.notificationBudgetPerWindow;

    const windowStart = new Date(Date.now() - env.agentNotificationBudgetWindowMs);

    const rows = await this.db
      .select({
        actionType: agentNotificationDeliveries.actionType,
        total: sql<string>`COUNT(*)`,
      })
      .from(agentNotificationDeliveries)
      .where(
        and(
          eq(agentNotificationDeliveries.workspaceId, workspaceId),
          eq(agentNotificationDeliveries.recipientUserId, userId),
          eq(agentNotificationDeliveries.outcome, 'delivered'),
          gte(agentNotificationDeliveries.occurredAt, windowStart),
        ),
      )
      .groupBy(agentNotificationDeliveries.actionType);

    let topActionType: { actionType: string; count: number } | null = null;

    for (const row of rows) {
      const count = Number(row.total);
      if (!topActionType || count > topActionType.count) {
        topActionType = { actionType: row.actionType, count };
      }
    }

    return { deliveredCountInWindow, overloaded, topActionType };
  }
}
