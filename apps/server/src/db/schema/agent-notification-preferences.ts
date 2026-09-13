import { integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F3-T13 (ADR-0047 Karar a/b/i): `agent_notification_preferences` — the read
 * model for per-`(workspaceId, userId)` personal notification preference. A
 * single current value per key (event-sourced upsert, no history rows), NO
 * `streamId` column (deterministically re-derived at the service layer) —
 * mirrors `task_autonomy_settings`'s exact shape. `quietHoursStartHourUtc`/
 * `quietHoursEndHourUtc` are nullable TOGETHER (both null means "no quiet
 * hours configured").
 */
export const agentNotificationPreferences = pgTable(
  'agent_notification_preferences',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 100 }).notNull(),
    notificationBudgetPerWindow: integer('notification_budget_per_window').notNull(),
    quietHoursStartHourUtc: integer('quiet_hours_start_hour_utc'),
    quietHoursEndHourUtc: integer('quiet_hours_end_hour_utc'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('agent_notification_preferences_workspace_user_idx').on(
      table.workspaceId,
      table.userId,
    ),
  ],
);
