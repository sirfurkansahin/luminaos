import { index, integer, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `ai_usage_records` — F1-T5 PR-C's append-only audit/quota-accounting log:
 * one row per `AIUsageRecorded` event (own dedicated event stream per
 * record, see `../../ai/ai-usage.projection.ts`), never updated or deleted.
 * `id` is the event's OWN id (a UUID, not a ULID business identity like
 * `objects_view`/`field_definitions` — this table has no separate business
 * identity of its own, it mirrors the event 1:1).
 *
 * Indexed on `workspace_id` — `refreshAIField`'s quota check
 * (`SUM(input_tokens + output_tokens)` grouped by `workspace_id`) is this
 * table's only query pattern.
 */
export const aiUsageRecords = pgTable(
  'ai_usage_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fieldDefinitionId: varchar('field_definition_id', { length: 26 }),
    objectId: varchar('object_id', { length: 26 }),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    model: varchar('model', { length: 64 }),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('ai_usage_records_workspace_id_idx').on(table.workspaceId)],
);
