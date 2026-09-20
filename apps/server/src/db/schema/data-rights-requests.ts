import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';

export const dataRightsRequestStatusEnum = pgEnum('data_rights_request_status', [
  'pending',
  'completed',
  'rejected',
]);

export const dataRightsRequests = pgTable(
  'data_rights_requests',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull().default('deletion'),
    status: dataRightsRequestStatusEnum('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('data_rights_requests_one_pending_per_user_idx')
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type DataRightsRequest = typeof dataRightsRequests.$inferSelect;
