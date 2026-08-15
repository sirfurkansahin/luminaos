import { pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `context_graph_field_types` — `ContextGraphProjection`'s OWN internal
 * field-type bookkeeping table (ADR-0017 Karar c). NOT a public read model
 * consumed by anything outside `ContextGraphProjection`: it exists purely so
 * the projection can classify a future `FieldValueChanged`'s `fieldKey` as
 * `select`/`multiSelect` (topic-worthy) or not, WITHOUT ever reading
 * `field_definitions` (a different projection's materialized table, folded
 * on its own independent checkpoint — reading it here would risk observing
 * stale data, per Karar c's rationale). Folded entirely from this
 * projection's own `FieldDefined` handling.
 *
 * `fieldDefinitionId` is stored for completeness/debuggability but not read
 * back by `ContextGraphProjection` itself (`FieldArchived`'s payload carries
 * only `fieldDefinitionId`, not `objectType`/`key`, so it cannot be used to
 * key a targeted cleanup here — see ADR-0017's accepted `FieldArchived`
 * limitation).
 */
export const contextGraphFieldTypes = pgTable(
  'context_graph_field_types',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectType: varchar('object_type', { length: 50 }).notNull(),
    fieldKey: varchar('field_key', { length: 200 }).notNull(),
    fieldType: varchar('field_type', { length: 20 }).notNull(),
    fieldDefinitionId: varchar('field_definition_id', { length: 26 }).notNull(),
  },
  (table) => [
    uniqueIndex('context_graph_field_types_workspace_object_type_field_key_key').on(
      table.workspaceId,
      table.objectType,
      table.fieldKey,
    ),
  ],
);
