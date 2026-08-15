import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { contextGraphNodes } from './context-graph-nodes.js';
import { workspaces } from './workspaces.js';

/**
 * `context_graph_edges` — ADR-0017 ("Bağlam Grafiği") Karar (a)/(f): a
 * materialized, workspace-isolated edge table for the context graph. Four
 * `edgeType`s share this one table (`entity-entity`/`entity-person`/
 * `entity-time`/`entity-topic`), mirroring `context_graph_nodes`'s own
 * 4-in-1 design.
 *
 * `sourceFieldKey` is populated ONLY for `entity-topic` edges derived from a
 * `FieldValueChanged` on a `select`/`multiSelect` field (Karar b/d) — `NULL`
 * for the type-based `entity-topic` edge created on `ObjectCreated`, and for
 * every `entity-entity`/`entity-person`/`entity-time` edge.
 *
 * `sourceRelationId` is an implementer-level addition (ADR-0017 Karar c's
 * "storage mechanism is an implementer detail" allowance, applied here to
 * the analogous `RelationCreated`/`RelationRemoved` -> `entity-entity` edge
 * problem): `RelationRemoved`'s payload carries ONLY `{ relationId }` (no
 * `fromId`/`toId`), so `ContextGraphProjection` needs SOME way, scoped to
 * its OWN table, to resolve which `entity-entity` edge a given `relationId`
 * corresponds to at delete time, without cross-reading `relations_view`
 * (that would violate Karar c's no-cross-projection-read discipline). This
 * column is `NULL` for every non-`entity-entity` edge.
 *
 * Postgres unique indexes treat every `NULL` as distinct from every other
 * `NULL`, so a single `UNIQUE(workspaceId, edgeType, fromNodeId, toNodeId,
 * sourceFieldKey)` index would NOT deduplicate the (very common) NULL-
 * `sourceFieldKey` edges via `onConflictDoNothing` -- re-folding the
 * identical `ObjectCreated`/`RelationCreated` event would insert a SECOND
 * row instead of being ignored. Split into two PARTIAL unique indexes
 * (`WHERE source_field_key IS NULL` / `WHERE source_field_key IS NOT NULL`)
 * instead -- the exact same partial-unique-index technique
 * `relations_view.ts`'s `relations_view_active_parent_key` already
 * established for this codebase's other NULL-sensitive uniqueness rule.
 */
export const contextGraphEdges = pgTable(
  'context_graph_edges',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    edgeType: varchar('edge_type', { length: 20 }).notNull(),
    fromNodeId: varchar('from_node_id', { length: 26 })
      .notNull()
      .references(() => contextGraphNodes.id, { onDelete: 'cascade' }),
    toNodeId: varchar('to_node_id', { length: 26 })
      .notNull()
      .references(() => contextGraphNodes.id, { onDelete: 'cascade' }),
    sourceFieldKey: varchar('source_field_key', { length: 200 }),
    sourceRelationId: varchar('source_relation_id', { length: 26 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('context_graph_edges_null_field_key_key')
      .on(table.workspaceId, table.edgeType, table.fromNodeId, table.toNodeId)
      .where(sql`source_field_key IS NULL`),
    uniqueIndex('context_graph_edges_field_key_key')
      .on(table.workspaceId, table.edgeType, table.fromNodeId, table.toNodeId, table.sourceFieldKey)
      .where(sql`source_field_key IS NOT NULL`),
    index('context_graph_edges_workspace_id_idx').on(table.workspaceId),
    index('context_graph_edges_from_node_id_idx').on(table.fromNodeId),
    index('context_graph_edges_to_node_id_idx').on(table.toNodeId),
    index('context_graph_edges_source_relation_id_idx').on(table.sourceRelationId),
  ],
);
