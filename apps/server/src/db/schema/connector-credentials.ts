import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T9 PR2 (ADR-0025 §i): one row per (workspaceId, userId, connectorType)
 * triple, storing a single JSON-serialized, `encryptSecret`-encrypted
 * "credentials blob" — the shape of the blob varies per connector type
 * (OAuth access/refresh pair, a single API key, etc.), which is why there is
 * only ONE `encryptedCredentials` text column rather than connector-specific
 * columns (see ADR-0025 §i's "Tekillik kısıtı kararı" / alternatives section).
 * Deliberately separate from `calendar_accounts` (Karar d) — a read-through
 * sync connection vs. an MCP protocol connection are conceptually different.
 */
export const connectorCredentials = pgTable(
  'connector_credentials',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorType: varchar('connector_type', { length: 50 }).notNull(),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('connector_credentials_workspace_user_type_key').on(
      table.workspaceId,
      table.userId,
      table.connectorType,
    ),
  ],
);
