import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `field_definitions` — the read model for F1-T2's field-definition
 * event-sourced entity (`FieldDefined`/`FieldUpdated`/`FieldArchived`),
 * mirroring `objects-view.ts`'s conventions: `id` is a ULID (business
 * identity, `varchar(26)`), `stream_id` is the UUID event-stream identity.
 *
 * A field's `key` is unique per `(workspace_id, object_type)`, not globally —
 * the same `key` may be reused for a different object type in the same
 * workspace (per F1-T2's plan).
 */
export const fieldDefinitions = pgTable(
  'field_definitions',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectType: varchar('object_type', { length: 50 }).notNull(),
    key: varchar('key', { length: 100 }).notNull(),
    label: text('label').notNull(),
    fieldType: varchar('field_type', { length: 20 }).notNull(),
    config: jsonb('config').notNull(),
    defaultValue: jsonb('default_value'),
    permissions: jsonb('permissions').notNull(),
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('field_definitions_workspace_object_type_key_key').on(
      table.workspaceId,
      table.objectType,
      table.key,
    ),
    index('field_definitions_workspace_object_type_lifecycle_idx').on(
      table.workspaceId,
      table.objectType,
      table.lifecycle,
    ),
  ],
);
