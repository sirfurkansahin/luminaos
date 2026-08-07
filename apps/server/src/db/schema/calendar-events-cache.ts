import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { calendarAccounts } from './calendar-accounts.js';
import { workspaces } from './workspaces.js';

/**
 * F1-T12 PR5c: a read-only, disposable cache of external calendar events
 * refreshed by `CalendarSyncPollerService`'s periodic polling (ADR-0012 §a --
 * "external events are NEVER event-sourced -- they are a read-only cache
 * refreshed by periodic polling"). Never a source of truth: rows here are
 * fully derivable by re-polling the connector, and may be dropped/rebuilt at
 * any time.
 *
 * `eventStart`/`eventEnd` (NOT `start`/`end`) mirrors `objects-view.ts`'s
 * `timeBlockStart`/`timeBlockEnd` reserved-word-avoidance precedent. A unique
 * index on `(calendarAccountId, externalId)` is what makes the poller's
 * upsert-by-`onConflictDoUpdate` possible.
 */
export const calendarEventsCache = pgTable(
  'calendar_events_cache',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    calendarAccountId: uuid('calendar_account_id')
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    eventStart: timestamp('event_start', { withTimezone: true }).notNull(),
    eventEnd: timestamp('event_end', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('calendar_events_cache_account_external_id_idx').on(
      table.calendarAccountId,
      table.externalId,
    ),
  ],
);
