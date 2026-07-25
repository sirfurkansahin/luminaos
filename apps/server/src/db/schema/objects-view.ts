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
    // F1-T6 PR-D: the query/filter/sort/group endpoint's own scoping predicate
    // is always `(workspaceId, type, lifecycle != 'deleted')` before any
    // caller-supplied filter/sort runs -- this composite index lets Postgres
    // prune to the relevant row set in one index scan rather than the
    // 2-column index above plus a residual `type` filter.
    index('objects_view_workspace_id_type_lifecycle_idx').on(
      table.workspaceId,
      table.type,
      table.lifecycle,
    ),
    // F1-T6 PR-D: a GIN index on `field_values` accelerates the jsonb
    // containment/array-membership operators (`?`/`?|`) `query-builder.ts`
    // uses for `multiSelect`/`people` filters (`in`/`notIn`/`contains`). It
    // does NOT accelerate the `->>`-text-extraction + cast predicates used
    // for scalar custom-field filters (`number`/`date`/`select`/...) --
    // Postgres cannot index an arbitrary dynamic jsonb key's scalar value
    // generically (only a per-key expression index would, which isn't
    // feasible for a dynamic custom-fields schema) -- those rely on the
    // `workspaceId`/`type`/`lifecycle` composite index above narrowing the
    // scanned row set first. See `docs/adr/ADR-0009-sorgu-katmani.md` for the
    // full performance-strategy writeup and the 10k-object benchmark that
    // validates it.
    index('objects_view_field_values_gin_idx').using('gin', table.fieldValues),
  ],
);
