import { randomUUID } from 'node:crypto';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { agentNotificationPreferences } from '../db/schema/agent-notification-preferences.js';

import type { Database } from '../db/client.js';

/** Mirrors `TaskAutonomySettingProjection`'s own `asDbTransaction`. */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

function requireIntegerPayloadField(event: DomainEvent, field: string): number {
  const value = event.payload[field];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

function readNullableIntegerField(
  quietHours: Record<string, unknown> | null,
  field: string,
): number | null {
  if (quietHours === null) {
    return null;
  }

  const value = quietHours[field];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidObjectStateError(
      `"AgentNotificationPreferenceSet" event's "quietHours.${field}" payload field is invalid`,
    );
  }

  return value;
}

/**
 * F3-T13 (ADR-0047 Karar a/b/i): `agent_notification_preferences` read-model
 * projection — structurally the same shape as `TaskAutonomySettingProjection`:
 * upserts on `(workspaceId, userId)`, a single current value per key (no
 * history rows). `id` is a fresh `randomUUID()` value ONLY on first insert
 * (the deterministic `streamId` is a service-layer-only concern, never
 * stored as a column here, same as `TaskAutonomySettingProjection`) — on
 * conflict the existing row's own `id` is preserved (`onConflictDoUpdate`'s
 * `set` never touches `id`).
 */
export class NotificationPreferenceProjection implements Projection {
  readonly name = 'agent-notification-preference';
  readonly handles: readonly string[] = ['AgentNotificationPreferenceSet'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const workspaceId = event.workspaceId;
    const userId = event.actor.id;
    const notificationBudgetPerWindow = requireIntegerPayloadField(
      event,
      'notificationBudgetPerWindow',
    );
    const quietHours = event.payload['quietHours'] as Record<string, unknown> | null;
    const quietHoursStartHourUtc = readNullableIntegerField(quietHours, 'startHourUtc');
    const quietHoursEndHourUtc = readNullableIntegerField(quietHours, 'endHourUtc');

    await dbTx
      .insert(agentNotificationPreferences)
      .values({
        id: randomUUID(),
        workspaceId,
        userId,
        notificationBudgetPerWindow,
        quietHoursStartHourUtc,
        quietHoursEndHourUtc,
        updatedAt: event.occurredAt,
      })
      .onConflictDoUpdate({
        target: [agentNotificationPreferences.workspaceId, agentNotificationPreferences.userId],
        set: {
          notificationBudgetPerWindow,
          quietHoursStartHourUtc,
          quietHoursEndHourUtc,
          updatedAt: event.occurredAt,
        },
      });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(agentNotificationPreferences);
  }
}
