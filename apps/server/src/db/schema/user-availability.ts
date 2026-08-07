import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';

/**
 * F1-T12 PR6: `user_availability` — the read model for `UserAvailability`, a
 * NON-LuminaObject, event-sourced, GLOBAL-PER-USER aggregate for Odak/OOO
 * (Focus/Out-of-office) status (ADR-0012 §f). One row per user (`userId` is
 * the primary key, not a separate surrogate id) — this is a last-write-wins
 * projection of `UserAvailabilityChanged` events, keyed by the user alone,
 * NEVER by workspace (the `workspaceId` on the underlying event is
 * audit-trail only; see `../availability/user-availability.service.ts`).
 */
export const userAvailability = pgTable('user_availability', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull(),
  until: timestamp('until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
