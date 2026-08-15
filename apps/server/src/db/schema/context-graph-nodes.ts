import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `context_graph_nodes` — ADR-0017 ("Bağlam Grafiği") Karar (a)/(f): a
 * materialized, workspace-isolated node table for the context graph derived
 * from the event log (`ContextGraphProjection`). Four `nodeType`s share this
 * one table (`entity`/`person`/`time`/`topic`, Karar a) rather than four
 * separate tables — their shared shape (a natural key scoped to a workspace)
 * is identical, and F2-T2's future graph-traversal queries benefit from a
 * single indexable table over a 4-way union.
 *
 * `objectType` is populated ONLY for `nodeType = 'entity'` rows (mirrors the
 * underlying `LuminaObject.type`); every other node type leaves it `NULL`.
 *
 * `id` is an internally-minted ULID (`varchar(26)`, mirrors `objects_view`/
 * `relations_view`/`field_definitions`' own PK convention) — NOT the same as
 * `naturalKey`, which carries the node's own domain identity (`objectId` for
 * `entity`, `actor.id` for `person`, a day-bucket string for `time`, a raw
 * field value or `objectType` string for `topic`).
 */
export const contextGraphNodes = pgTable(
  'context_graph_nodes',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    nodeType: varchar('node_type', { length: 20 }).notNull(),
    naturalKey: text('natural_key').notNull(),
    objectType: varchar('object_type', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The idempotent-folding target: `ContextGraphProjection`'s
    // `onConflictDoNothing` upserts against this exact index, the same
    // pattern `field_definitions`/`relations_view` already use.
    uniqueIndex('context_graph_nodes_workspace_type_natural_key_key').on(
      table.workspaceId,
      table.nodeType,
      table.naturalKey,
    ),
    index('context_graph_nodes_workspace_id_idx').on(table.workspaceId),
  ],
);
