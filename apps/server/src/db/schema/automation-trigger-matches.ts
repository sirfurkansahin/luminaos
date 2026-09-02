import { pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';

import { automationTriggers } from './automation-triggers.js';

/**
 * `automation_trigger_matches` — ADR-0032 Karar (b)'s dedup mechanism's core
 * DB-level guarantee: a pure, fully re-derivable projection (NOT a source of
 * truth) tracking which objects currently match a condition trigger, so a
 * poll tick can diff the current match set against the previous one and
 * fire only on genuine edges (a falling edge re-arms the trigger).
 *
 * `triggerId` IS a real FK to `automation_triggers.id` (a physical,
 * FK-able table) with `onDelete: 'cascade'` -- security-review finding
 * (F2-T15 PR1): unlike `objectId`, there is no reason for this one to be
 * FK-less, and leaving it unconstrained would let orphaned match rows
 * accumulate against a nonexistent trigger.
 *
 * `objectId` is deliberately FK-less -- a direct reference into
 * `objects_view`, an event-log projection, not a physical FK-able table
 * (same rationale as `meeting_details.object_id`). See ADR-0032 "Şema
 * Taslağı".
 */
export const automationTriggerMatches = pgTable(
  'automation_trigger_matches',
  {
    triggerId: varchar('trigger_id', { length: 26 })
      .notNull()
      .references(() => automationTriggers.id, { onDelete: 'cascade' }),
    objectId: varchar('object_id', { length: 26 }).notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.objectId] })],
);
