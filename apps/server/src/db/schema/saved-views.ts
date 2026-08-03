import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * `saved_views` — the read model for F1-T9's saved-view event-sourced entity
 * (`SavedViewCreated`/`SavedViewUpdated`/`SavedViewDeleted`), mirroring
 * `field-definitions.ts`'s conventions: `id` is a ULID (business identity,
 * `varchar(26)`), `stream_id` is the UUID event-stream identity.
 *
 * `owner_id: null` means a shared (workspace-wide) view; a non-null
 * `owner_id` means a personal view visible only to that user (see the F1-T9
 * plan's "Kararlar" section). `lifecycle` follows `field_definitions`'
 * soft-delete discipline (`SavedViewDeleted` sets `lifecycle: 'deleted'`, it
 * never hard-deletes the row) rather than `relations_view`'s hard-delete.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectType: varchar('object_type', { length: 50 }).notNull(),
    name: text('name').notNull(),
    icon: varchar('icon', { length: 100 }).notNull(),
    viewType: varchar('view_type', { length: 20 }).notNull(),
    querySpec: jsonb('query_spec').notNull(),
    dateField: varchar('date_field', { length: 200 }),
    startField: varchar('start_field', { length: 200 }),
    endField: varchar('end_field', { length: 200 }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('saved_views_workspace_id_object_type_lifecycle_idx').on(
      table.workspaceId,
      table.objectType,
      table.lifecycle,
    ),
    index('saved_views_workspace_id_owner_id_lifecycle_idx').on(
      table.workspaceId,
      table.ownerId,
      table.lifecycle,
    ),
  ],
);
