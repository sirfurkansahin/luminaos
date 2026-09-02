import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { webhookSubscriptions } from './webhook-subscriptions.js';

/**
 * F2-T16 PR2 (ADR-0033 §d, "Şema Taslağı"): a durable queue table for
 * outbound webhook deliveries, enqueued in the SAME projection-runner
 * catch-up transaction as `command_proposals` (`webhook-delivery-enqueue.
 * projection.ts`) so enqueue durability matches the event log's own
 * guarantee -- never the dormant `InProcessEventBus`, never inline
 * fire-and-forget (see ADR-0033 §d).
 *
 * `subscriptionId` is deliberately FK'd to `webhook_subscriptions.id`
 * (unlike `automation_trigger_matches.triggerId`'s FK-less-by-design
 * precedent) because this is a physical table, not a projection.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: varchar('subscription_id', { length: 26 })
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 40 }).notNull(),
    payload: jsonb('payload').notNull(), // gönderilen TAM body (imzalanan JSON.stringify çıktısıyla aynı)
    status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'delivered' | 'failed'
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'), // nullable, sanitize edilmiş mesaj -- yanıt gövdesi ASLA
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }), // nullable
  },
  (table) => [
    index('webhook_deliveries_status_next_attempt_at_idx').on(table.status, table.nextAttemptAt),
    index('webhook_deliveries_subscription_id_idx').on(table.subscriptionId),
  ],
);
