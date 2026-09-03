import { index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F3-T1 PR3 (ADR-0035 Karar g): `agent_action_executions` — an insert-only
 * audit ledger, one row per `AgentResourceLimitsService.recordAgentAction`
 * call (itself invoked from `executeAgentAction`'s own instrumentation,
 * regardless of whether the sandboxed action ultimately succeeded, failed,
 * or timed out). Structurally close to `ai_usage_records.ts` (F1-T5 PR-C) —
 * a pure append-only accounting log with no business-uniqueness constraint
 * to reconcile, and no unique index, since MANY rows are expected per
 * `(workspaceId, agentIdentifier)` pair over time (this table doubles as the
 * DB-backed rate-limit window's own count source, per
 * `assertActionRateNotExceeded`).
 *
 * Indexed on `(workspace_id, agent_identifier, occurred_at)` — matches
 * `assertActionRateNotExceeded`'s exact query shape (`WHERE workspace_id = ?
 * AND agent_identifier = ? AND occurred_at >= ?`), same reasoning as
 * `ai_usage_records`'s own workspace-id index for its one query pattern.
 */
export const agentActionExecutions = pgTable(
  'agent_action_executions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('agent_action_executions_workspace_agent_occurred_idx').on(
      table.workspaceId,
      table.agentIdentifier,
      table.occurredAt,
    ),
  ],
);
