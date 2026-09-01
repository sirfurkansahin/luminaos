import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Per ADR-0031 §a ("Saklama tercihi — `meeting_retention_preferences`,
 * workspace-başına TEK satır") — copied verbatim, adjusted only for real
 * import paths.
 */
export const meetingRetentionModeEnum = pgEnum('meeting_retention_mode', [
  'recording-reference',
  'transcript-only',
  'summary-only',
]);

export const meetingRetentionPreferences = pgTable(
  'meeting_retention_preferences',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mode: meetingRetentionModeEnum('mode').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Workspace başına EN FAZLA bir satır -- "bir upsert değil, gerçek bir
    // benzersizlik" invariant'ını DB seviyesinde de garanti eder (aynı
    // `meeting_details_object_id_idx`'in ADR-0030 §d'de kurduğu gerekçe).
    uniqueIndex('meeting_retention_preferences_workspace_id_idx').on(table.workspaceId),
  ],
);
