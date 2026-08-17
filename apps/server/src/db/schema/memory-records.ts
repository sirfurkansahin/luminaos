import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T5 PR2 (ADR-0022 Karar b/d/f): `memory_records` — the read model for
 * Memory Passport entries. `id` is an internally-minted ULID (`varchar(26)`),
 * mirroring `desktop_signal_consents.id`'s own PK convention. `streamId`
 * (uuid, unique) mirrors `objects_view.stream_id`'s exact precedent: since
 * `MemoryRecordAdded`'s payload is `.strict()` `{content}` only (no room to
 * smuggle the app-minted `id` back through the event), the projection mints
 * `id` itself on insert and relies on `streamId` (always present on every
 * event's envelope, including `MemoryRecordEdited`/`MemoryRecordDeleted`) to
 * find the right row again for later events on the same per-record stream.
 * `kaynakOlayId` is the (self-referential, v1) `MemoryRecordAdded` event id,
 * never `null` (Karar b). `deletedAt` is the tombstone column (Karar d) — a
 * `MemoryRecordDeleted` event NEVER physically removes the row, it only sets
 * this timestamp; every read query filters `deletedAt IS NULL`. Isolation is
 * the `(workspaceId, userId)` pair (Karar f), same FK/cascade shape as
 * `desktop_signal_consents`.
 */
export const memoryRecords = pgTable('memory_records', {
  id: varchar('id', { length: 26 }).primaryKey(),
  streamId: uuid('stream_id').notNull().unique(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  kaynakOlayId: uuid('kaynak_olay_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
