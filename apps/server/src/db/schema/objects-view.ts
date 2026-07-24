import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * The `objects_view` read-model projection (ADR-0003 "Okuma modeli ve
 * projeksiyon tazeliği"): maps a Lumina Object's business identity (`id`, a
 * ULID) to its event-stream identity (`stream_id`, a UUID) and mirrors its
 * current, derived state for cheap reads. `get`/`list` read directly from
 * this table; command decisions never do (they always replay `events`).
 *
 * `id` is a ULID, not a UUID — 26 Crockford-base32 characters — hence
 * `varchar(26)` rather than a `uuid` column.
 *
 * `field_values` (F1-T2 PR-C): a flat `{ [fieldKey]: value }` JSONB map of
 * this object's custom field values, folded from `FieldValueChanged` events
 * on the object's OWN event stream (per the plan's central architecture
 * decision — field values are not a separate stream). Defaults to `{}` so
 * every row always has a well-formed map, never `null`.
 */
export const objectsView = pgTable(
  'objects_view',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    type: varchar('type', { length: 50 }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    lifecycle: varchar('lifecycle', { length: 20 }).notNull(),
    fieldValues: jsonb('field_values').notNull().default({}),
  },
  (table) => [
    index('objects_view_workspace_id_lifecycle_idx').on(table.workspaceId, table.lifecycle),
  ],
);
