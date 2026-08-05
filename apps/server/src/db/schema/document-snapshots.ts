import {
  customType,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Postgres `bytea` column carried as a Node `Buffer` in JS. This repo has no
 * other `bytea` usage, so the column type is introduced here via drizzle's
 * `customType`: `bytea` round-trips as a `Buffer` (the `pg` driver already
 * returns `bytea` values as `Buffer`), which is what
 * `DocumentReconstructionService.getLatestSnapshot` returns byte-for-byte.
 */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * `document_snapshots` (ADR-0011 §(f)): a separate, purpose-built table for a
 * `doc` object's periodic full-state Yjs snapshots — deliberately NOT folded
 * into `objects_view`'s jsonb (that table loads on every list/query; a large
 * binary blob there would bloat every list response, while a snapshot is only
 * needed when the doc is actually opened).
 *
 * NO foreign key to `objects_view`: the snapshot projection is an INDEPENDENT
 * consumer of the event log and must persist a snapshot even if the
 * `objects_view` projection has not caught up to the doc's `ObjectCreated`
 * event yet — an FK would couple the two projections' ordering.
 *
 * The composite primary key `(object_id, version)` makes the projection
 * idempotent (`ON CONFLICT (object_id, version) DO NOTHING` on replay) and
 * also serves the `MAX(version)` "latest snapshot" lookup.
 */
export const documentSnapshots = pgTable(
  'document_snapshots',
  {
    // The doc's own ULID (== `docId`) — 26 Crockford-base32 chars, hence
    // `varchar(26)` rather than a `uuid` column.
    objectId: varchar('object_id', { length: 26 }).notNull(),
    // The DomainEvent envelope version (stream position assigned by
    // `EventStoreService.append`), NOT the payload's own `version` field.
    version: integer('version').notNull(),
    snapshot: bytea('snapshot').notNull(),
    // Written from the event envelope's `workspaceId`; the cascade removes a
    // workspace's doc content when the workspace is deleted (data-hygiene /
    // privacy).
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.objectId, table.version] })],
);
