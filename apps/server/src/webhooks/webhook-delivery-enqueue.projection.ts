import { and, eq } from 'drizzle-orm';

import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { webhookDeliveries } from '../db/schema/webhook-deliveries.js';
import { webhookSubscriptions } from '../db/schema/webhook-subscriptions.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `ActionProposalProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

/**
 * `webhook_deliveries` enqueue projection (F2-T16 PR2, ADR-0033 §d/§e): turns
 * `ActionsProposed`/`ActionsDecided` events into one `webhook_deliveries` row
 * per ACTIVE subscription (in the event's own workspace, per its own
 * `eventTypes` allowlist) -- runs in the SAME `ProjectionRunner.catchUp`
 * transaction as `command_proposals` (`../commands/action-proposal.
 * projection.ts`), so enqueue durability matches the event log's own
 * guarantee.
 *
 * Reads `event.workspaceId` -- the `DomainEvent` envelope's OWN top-level
 * field -- never `event.payload.workspaceId`, which is absent on a real
 * `ActionsDecided` event (`CommandsService.decide()`'s payload is only
 * `{ proposalId, decisions }`).
 *
 * The `eventTypes` allowlist filter runs in application code, not SQL,
 * because `webhook_subscriptions.eventTypes` is a `jsonb` array column
 * (no portable `@>`/`?` operator wired through Drizzle here yet) -- fine at
 * this table's expected scale (per-workspace subscription counts, not a
 * hot path).
 */
export class WebhookDeliveryEnqueueProjection implements Projection {
  readonly name = 'webhook-delivery-enqueue';
  readonly handles: readonly string[] = ['ActionsProposed', 'ActionsDecided'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const activeSubscriptions = await dbTx
      .select({
        id: webhookSubscriptions.id,
        eventTypes: webhookSubscriptions.eventTypes,
      })
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.workspaceId, event.workspaceId),
          eq(webhookSubscriptions.lifecycle, 'active'),
        ),
      );

    const matchingSubscriptions = activeSubscriptions.filter((subscription) =>
      (subscription.eventTypes as string[]).includes(event.type),
    );

    if (matchingSubscriptions.length === 0) {
      return;
    }

    const now = new Date();
    const payload = {
      eventType: event.type,
      occurredAt: event.occurredAt.toISOString(),
      data: event.payload,
    };

    await dbTx.insert(webhookDeliveries).values(
      matchingSubscriptions.map((subscription) => ({
        subscriptionId: subscription.id,
        eventType: event.type,
        payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })),
    );
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(webhookDeliveries);
  }
}
