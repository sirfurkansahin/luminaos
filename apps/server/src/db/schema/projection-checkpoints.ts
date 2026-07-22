import { bigint, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Tracks each `Projection`'s last successfully processed
 * `events.global_position`, so `ProjectionRunner`'s catch-up loop can resume
 * from where it left off rather than replaying the whole log every time. See
 * F0-T6's plan (`giggly-brewing-moore.md`): the runner advances a
 * projection's checkpoint in the SAME transaction as the events it derived
 * from being applied — crash-safe, effectively-once processing.
 */
export const projectionCheckpoints = pgTable('projection_checkpoints', {
  projectionName: varchar('projection_name', { length: 200 }).primaryKey(),
  lastPosition: bigint('last_position', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
