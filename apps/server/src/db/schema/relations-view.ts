import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { objectsView } from './objects-view.js';
import { workspaces } from './workspaces.js';

/**
 * `relations_view` — the read model for F1-T3's relation event-sourced
 * entity (`RelationCreated`/`RelationRemoved`), mirroring `field-definitions.
 * ts`'s conventions: `id` is a ULID (business identity, `varchar(26)`),
 * `stream_id` is the UUID event-stream identity.
 *
 * Unlike `field_definitions`/`objects_view`, there is no `lifecycle`/`status`
 * column here: a `RelationRemoved` event hard-deletes the row (see
 * `RelationsViewProjection`) — there is no "removed but visible" state at the
 * read-model level, only in the pure domain's own `Relation.status`.
 */
export const relationsView = pgTable(
  'relations_view',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromId: varchar('from_id', { length: 26 })
      .notNull()
      .references(() => objectsView.id, { onDelete: 'cascade' }),
    toId: varchar('to_id', { length: 26 })
      .notNull()
      .references(() => objectsView.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('relations_view_workspace_id_kind_idx').on(table.workspaceId, table.kind),
    index('relations_view_workspace_id_from_id_idx').on(table.workspaceId, table.fromId),
    index('relations_view_workspace_id_to_id_idx').on(table.workspaceId, table.toId),
    // DB-level backstop for the "at most one active parentChild relation per
    // child" business rule (security review finding): the in-memory
    // pre-check in `RelationsService.create` alone cannot prevent two
    // concurrent creates for the same child from both passing before either
    // commits, since each relation lives in its own independent event
    // stream. This PARTIAL unique index (only applies where
    // `kind = 'parentChild'`) makes the losing concurrent insert fail at the
    // database level instead. See `RelationsViewProjection`'s
    // `RelationCreated` case (`onConflictDoNothing` targeting this index) and
    // `RelationsService.create`'s post-catchUp existence check for how the
    // "loser" is turned into a `ConflictError` rather than a false success.
    uniqueIndex('relations_view_active_parent_key')
      .on(table.workspaceId, table.toId)
      .where(sql`kind = 'parentChild'`),
  ],
);
