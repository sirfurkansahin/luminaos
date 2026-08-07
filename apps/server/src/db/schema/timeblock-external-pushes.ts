import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { calendarAccounts } from './calendar-accounts.js';

/**
 * F1-T12 PR5d: one row per (timeblock object, connected calendar account)
 * pairing that has ever been successfully pushed to that external calendar —
 * the mapping `TimeBlockPushService` consults to decide `createEvent` vs.
 * `updateEvent`, and to resolve which `externalId`s to `deleteEvent` on
 * clear.
 *
 * `objectId` is the timeblock's own ULID (26 Crockford-base32 chars, hence
 * `varchar(26)`, not `uuid`) with deliberately NO foreign key to
 * `objects_view` — mirrors `document_snapshots.objectId`'s own precedent:
 * this table is an independent consumer of the write path, not a projection
 * that must stay in lockstep with `objects_view`'s own catch-up ordering.
 *
 * `calendarAccountId` DOES cascade from `calendar_accounts` — disconnecting
 * an account should drop its own push mappings.
 */
export const timeblockExternalPushes = pgTable(
  'timeblock_external_pushes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    objectId: varchar('object_id', { length: 26 }).notNull(),
    calendarAccountId: uuid('calendar_account_id')
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('timeblock_external_pushes_object_account_idx').on(
      table.objectId,
      table.calendarAccountId,
    ),
  ],
);
