import { index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `automation_triggers` — the read model for F2-T15's event-sourced
 * `Trigger` entity (`TriggerCreated`/`TriggerUpdated`/`TriggerDeleted`,
 * `packages/automation`'s `trigger-commands.ts`/`trigger-replay.ts`),
 * mirroring `saved-views.ts`'s conventions: `id` is a ULID (business
 * identity, `varchar(26)`), `stream_id` is the UUID event-stream identity.
 * See ADR-0032 "Şema Taslağı".
 */
export const automationTriggers = pgTable(
  'automation_triggers',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(), // 'scheduled' | 'condition'
    spec: jsonb('spec').notNull(), // discriminated ScheduleSpec | ConditionSpec
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }), // yalnızca 'scheduled' kullanır
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('automation_triggers_workspace_id_lifecycle_idx').on(table.workspaceId, table.lifecycle),
    index('automation_triggers_workspace_id_kind_lifecycle_idx').on(
      table.workspaceId,
      table.kind,
      table.lifecycle,
    ),
  ],
);
