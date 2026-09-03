import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { automationTriggers } from './automation-triggers.js';
import { workspaces } from './workspaces.js';

/**
 * `trigger_template_suggestions` — the read model for F2-T17's event-sourced
 * `trigger-template-suggestion` entity (`TriggerTemplateSuggested`/
 * `TriggerTemplateApproved`/`TriggerTemplateRejected`, ADR-0034 Karar (c)/(d)).
 * Mirrors `command_proposals`'s architecture (own stream type, `pending →
 * approved|rejected` state machine) but is a NEW, INDEPENDENT event-sourced
 * entity -- it does NOT join `command_proposals` (ADR-0034 Karar (c)).
 *
 * `createdTriggerId` is a REAL FK into `automation_triggers` (a physical
 * table, ADR-0033 §h's `webhook_deliveries.subscriptionId` FK reasoning) --
 * unlike ADR-0032's `objectId`, which deliberately has no FK into the
 * `objects_view` projection.
 */
export const triggerTemplateSuggestions = pgTable(
  'trigger_template_suggestions',
  {
    id: varchar('id', { length: 26 }).primaryKey(), // ULID, business identity (= suggestionId)
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: varchar('kind', { length: 20 }).notNull(), // 'scheduled' | 'condition'
    spec: jsonb('spec').notNull(), // candidate TriggerSpec
    rationale: text('rationale').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
    createdTriggerId: varchar('created_trigger_id', { length: 26 }).references(
      () => automationTriggers.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    index('trigger_template_suggestions_workspace_id_status_idx').on(
      table.workspaceId,
      table.status,
    ),
  ],
);
