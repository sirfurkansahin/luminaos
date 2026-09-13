import { newObjectId } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { agentNotificationDeliveries } from '../db/schema/agent-notification-deliveries.js';

import type { Database } from '../db/client.js';

/** Mirrors `AgentActionExecutionsProjection`'s own `asDbTransaction`. */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

function requireStringPayloadField(event: DomainEvent, field: string): string {
  const value = event.payload[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * F3-T13 PR2 (ADR-0047 Karar a/d): `agent_notification_deliveries` read-model
 * projection -- one row per `AgentNotificationDelivered`/
 * `AgentNotificationSuppressed` event, structurally close to
 * `AgentActionExecutionsProjection`: a pure append-only audit/accounting log
 * (each event lives on its own fresh stream), but its own primary key is a
 * fresh `newObjectId()` (ULID, `varchar(26)`) rather than the event's own
 * `id` -- mirrors `AgentActionRecordsProjection`'s exact convention, since
 * `agent_notification_deliveries.id` is `varchar(26)` (a ULID width) while a
 * `DomainEvent.id` is a `randomUUID()` (36 chars) and would not fit. Idempotent
 * replay-safety instead comes from the surrounding `ProjectionRunner`'s own
 * "each event applied exactly once" contract (no business-uniqueness
 * constraint to reconcile here either way, same as `AgentActionRecordsProjection`).
 */
export class AgentNotificationDeliveriesProjection implements Projection {
  readonly name = 'agent-notification-deliveries';
  readonly handles: readonly string[] = [
    'AgentNotificationDelivered',
    'AgentNotificationSuppressed',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    if (
      event.type !== 'AgentNotificationDelivered' &&
      event.type !== 'AgentNotificationSuppressed'
    ) {
      return;
    }

    const dbTx = asDbTransaction(tx);

    const recipientUserId = requireStringPayloadField(event, 'recipientUserId');
    const actionType = requireStringPayloadField(event, 'actionType');
    const sourceObjectId = requireStringPayloadField(event, 'sourceObjectId');

    const outcome =
      event.type === 'AgentNotificationDelivered'
        ? 'delivered'
        : requireStringPayloadField(event, 'reason') === 'quiet_hours'
          ? 'suppressed_quiet_hours'
          : 'suppressed_budget_exceeded';

    const commentId =
      event.type === 'AgentNotificationDelivered'
        ? requireStringPayloadField(event, 'commentId')
        : null;

    await dbTx.insert(agentNotificationDeliveries).values({
      id: newObjectId(),
      workspaceId: event.workspaceId,
      recipientUserId,
      actionType,
      sourceObjectId,
      outcome,
      commentId,
      occurredAt: event.occurredAt,
    });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(agentNotificationDeliveries);
  }
}
