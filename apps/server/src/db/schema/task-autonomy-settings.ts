import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F3-T5 (ADR-0039 Karar a/b): `task_autonomy_settings` — the read model for
 * per-`(workspaceId, actionType)` autonomy tier settings. Structurally close
 * to `agent_permission_manifests.ts` (F3-T1, ADR-0035): a single current
 * value per key (event-sourced upsert, no history rows), NO `streamId`
 * column (deterministically re-derived from `(workspaceId, actionType)` at
 * the service layer, same as `agent_permission_manifests`). `updatedByType`/
 * `updatedById` flatten the envelope's own `actor` into two columns —
 * mirrors `agent_action_records.ts`'s `actorType`/`actorId` convention.
 */
export const taskAutonomySettings = pgTable(
  'task_autonomy_settings',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    tier: varchar('tier', { length: 20 }).notNull(),
    updatedByType: varchar('updated_by_type', { length: 20 }).notNull(),
    updatedById: varchar('updated_by_id', { length: 100 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('task_autonomy_settings_workspace_action_type_key').on(
      table.workspaceId,
      table.actionType,
    ),
  ],
);
