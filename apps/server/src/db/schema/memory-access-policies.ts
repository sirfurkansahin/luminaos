import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T8 (ADR-0024 Karar i): `memory_access_policies` — the read model for
 * per-(workspace, user, agentIdentifier) Memory Passport access grant/revoke
 * rows, the BIREBIR structural equivalent of `desktop_signal_consents.ts`
 * (`signalType` -> `agentIdentifier`). One row per (workspaceId, userId,
 * agentIdentifier) triple. `id` is an internally-minted ULID (`varchar(26)`),
 * NOT part of the natural key. `agentIdentifier` is `varchar(100)` (wider
 * than `signal_type`'s `varchar(30)`) since ADR-0024 Karar (a) leaves the
 * identifier unconstrained (no enum) — future (F3-T1) agent identifiers may
 * be longer than today's short strings. A re-grant after a revoke resets
 * `revokedAt` back to `null` (ADR-0024 §j) rather than accumulating separate
 * rows; a revoke NEVER physically deletes the row.
 */
export const memoryAccessPolicies = pgTable(
  'memory_access_policies',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('memory_access_policies_workspace_user_agent_key').on(
      table.workspaceId,
      table.userId,
      table.agentIdentifier,
    ),
  ],
);
