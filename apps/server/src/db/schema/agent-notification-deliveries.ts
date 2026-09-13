import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F3-T13 (ADR-0047 Karar a/d): `agent_notification_deliveries` — the read
 * model for the "context-switch counter". One row per `AgentNotificationDelivered`/
 * `AgentNotificationSuppressed` event, INSERT-ONLY (each event lives on its
 * own fresh stream and is never updated) — mirrors `agent_action_records`'s
 * "record-per-fresh-stream" shape. `commentId` is non-null only when
 * `outcome === 'delivered'`.
 */
export const agentNotificationDeliveries = pgTable(
  'agent_notification_deliveries',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recipientUserId: varchar('recipient_user_id', { length: 100 }).notNull(),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    sourceObjectId: uuid('source_object_id').notNull(),
    outcome: varchar('outcome', { length: 30 }).notNull(),
    commentId: uuid('comment_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_notification_deliveries_recipient_occurred_idx').on(
      table.recipientUserId,
      table.occurredAt,
    ),
  ],
);
