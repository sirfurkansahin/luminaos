import {
  customType,
  index,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Postgres `tsvector` column. This repo has no other `tsvector` usage, so the
 * column type is introduced here via drizzle's `customType`, mirroring
 * `document-snapshots.ts`'s own `bytea` `customType` precedent for a Postgres
 * type drizzle-orm has no native column builder for.
 */
const tsvectorType = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * `search_index` (F1-T13, ADR-0013 §(d)): a title-only full-text-search
 * projection, folded from `ObjectCreated`/`ObjectRenamed` events on a Lumina
 * Object's own event stream (see `SearchIndexProjection`). ONE row per
 * object (`object_id` is the primary key, unlike `document_snapshots`'s
 * composite `(object_id, version)` key) -- this table always mirrors the
 * object's CURRENT title, never a history of past titles.
 *
 * `doc_text`/`embedding` are deliberately included in this PR's schema but
 * left unwritten (`NULL`) -- a follow-up PR3b folds
 * `DocumentContentSnapshotted` (Yjs-decoded doc text) into `doc_text` and
 * recomputes `tsv` to include it; `embedding` is reserved for a future
 * semantic-search PR. Adding both columns now avoids a second migration for
 * this same table shortly after this one.
 */
export const searchIndex = pgTable(
  'search_index',
  {
    // The object's own ULID (== `objects_view.id`) -- 26 Crockford-base32
    // characters, hence `varchar(26)` rather than a `uuid` column, mirroring
    // every other object-id column in this schema (`objects-view.ts`,
    // `document-snapshots.ts`).
    objectId: varchar('object_id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    docText: text('doc_text'),
    tsv: tsvectorType('tsv').notNull(),
    embedding: real('embedding').array(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('search_index_tsv_gin_idx').using('gin', table.tsv)],
);
