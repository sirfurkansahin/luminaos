import { jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F3-T1 (ADR-0035 Karar b/c/d): `agent_permission_manifests` — the read
 * model for per-(workspace, agentIdentifier) agent runtime permission
 * grant/revoke rows. Structurally close to `memory_access_policies.ts`
 * (F2-T8, ADR-0024), but deliberately 2-parted `(workspaceId,
 * agentIdentifier)` -- NO `userId` -- since this manifest answers a
 * workspace-level runtime-authority question, not a personal-consent one
 * (ADR-0035 Karar d). `dataScope`/`actionTypes` are jsonb (ADR-0035 Karar c:
 * `AgentDataScope`/`AgentActionType[]` are not closed unions). `startsAt`/
 * `expiresAt` are separate nullable timestamp columns (not nested inside a
 * jsonb `timeWindow`) mirroring ADR-0035's own pinned schema shape. A
 * re-grant after a revoke resets `revokedAt` back to `null` (upsert, ADR-0035
 * Karar c) rather than accumulating a second row; a revoke NEVER physically
 * deletes the row (same tombstone principle as `memory_access_policies`).
 */
export const agentPermissionManifests = pgTable(
  'agent_permission_manifests',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    dataScope: jsonb('data_scope').notNull(),
    actionTypes: jsonb('action_types').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_permission_manifests_workspace_agent_key').on(
      table.workspaceId,
      table.agentIdentifier,
    ),
  ],
);
