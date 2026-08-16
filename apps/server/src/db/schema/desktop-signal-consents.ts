import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T3 PR1 (ADR-0020 Karar a): `desktop_signal_consents` — the read model
 * for per-(workspace, user, signalType) desktop-signal-collection consent.
 * One row per (workspaceId, userId, signalType) triple (granular: consenting
 * to `active-window` says nothing about `calendar-status`). `id` is an
 * internally-minted ULID (`varchar(26)`, mirrors `context_graph_nodes`/
 * `objects_view`/`relations_view`/`field_definitions`' own PK convention) —
 * NOT part of the natural key. A re-grant after a revoke resets `revokedAt`
 * back to `null` (Karar a) rather than accumulating separate rows.
 */
export const desktopSignalConsents = pgTable(
  'desktop_signal_consents',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    signalType: varchar('signal_type', { length: 30 }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('desktop_signal_consents_workspace_user_signal_type_key').on(
      table.workspaceId,
      table.userId,
      table.signalType,
    ),
  ],
);
