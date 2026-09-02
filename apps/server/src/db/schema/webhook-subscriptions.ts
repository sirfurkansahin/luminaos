import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F2-T16 PR1 (ADR-0033 §h, "Şema Taslağı"): a flat, non-event-sourced CRUD
 * table for an outbound webhook subscription -- structurally identical in
 * shape to `connector_credentials` (F2-T9/ADR-0025), NOT
 * `automation_triggers`'s event-sourced read-model pattern, because a
 * webhook subscription has no consuming domain state machine (see ADR-0033
 * §h for the full reasoning).
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: varchar('id', { length: 26 }).primaryKey(), // ULID
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetUrl: text('target_url').notNull(), // https:// zorunlu, yazma-anı assertSafeWebhookUrl doğrulaması
    eventTypes: jsonb('event_types').notNull(), // string[], zod ile ['ActionsProposed','ActionsDecided'] alt-kümesine kısıtlı
    encryptedSigningSecret: text('encrypted_signing_secret').notNull(), // encryptSecret() çıktısı
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'), // 'active' | 'deleted'
    createdByUserId: uuid('created_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('webhook_subscriptions_workspace_id_lifecycle_idx').on(
      table.workspaceId,
      table.lifecycle,
    ),
  ],
);
