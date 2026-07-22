import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * The append-only, immutable event log — LuminaOS's single source of truth
 * (CLAUDE.md, "Mimari Değişmezler"). See F0-T6's plan
 * (`giggly-brewing-moore.md`) for the full design rationale.
 *
 * Deliberate deviations from the rest of the schema's conventions:
 *
 * - `id` has **no** `.default(sql\`gen_random_uuid()\`)`: it is
 *   caller-supplied. Idempotent replay (`EventStoreService.append`'s
 *   no-op-on-duplicate-id behavior) requires the caller to be able to name
 *   the same event id again on retry; a server-assigned default would make
 *   that impossible.
 * - `workspace_id`'s FK is `ON DELETE NO ACTION`, not `cascade` (every other
 *   FK in this schema cascades). An immutable log must never be silently
 *   destroyed as a side effect of deleting a workspace row.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    globalPosition: bigint('global_position', { mode: 'number' }).generatedAlwaysAsIdentity(),
    streamId: uuid('stream_id').notNull(),
    streamType: varchar('stream_type', { length: 100 }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'no action' }),
    type: varchar('type', { length: 200 }).notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    actor: jsonb('actor').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('events_stream_id_version_key').on(table.streamId, table.version),
    index('events_workspace_id_global_position_idx').on(table.workspaceId, table.globalPosition),
    index('events_global_position_idx').on(table.globalPosition),
  ],
);
