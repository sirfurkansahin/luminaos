import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * F3-T4 (ADR-0038 Karar a/b): `agent_action_records` — the unified read
 * model for the "Flight Recorder" ledger. One row per `AgentActionRecorded`
 * event, INSERT-ONLY (each event lives on its own fresh stream and is never
 * updated — unlike `agent_permission_manifests`'s per-key upsert). Covers
 * BOTH provenance paths (`decided` via `CommandsService.executeDecidedAction`,
 * `autonomous` via `MentionActionWorker`) in one table (ADR-0038 İnsan Kararı
 * 1) — deliberately separate from `agent_action_executions` (F3-T1's
 * rate-limit counter table, unchanged, not superseded).
 *
 * `actorType`/`actorId` are the envelope's own `actor` (a real user id for
 * `decided`, an `agentIdentifier` for `autonomous`) — flattened into two
 * columns rather than a nested jsonb, mirroring how `actor` is read off
 * `DomainEvent.actor` at projection time, never duplicated in the payload.
 * `resources`/`rollbackPlan`/`resultRef` are jsonb (ADR-0038's discriminated
 * union shapes, validated by `agentActionRecordedPayloadSchema` before this
 * projection ever sees them).
 */
export const agentActionRecords = pgTable(
  'agent_action_records',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provenance: varchar('provenance', { length: 20 }).notNull(),
    actorType: varchar('actor_type', { length: 20 }).notNull(),
    actorId: varchar('actor_id', { length: 100 }).notNull(),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    intent: text('intent').notNull(),
    rationale: text('rationale').notNull(),
    resources: jsonb('resources').notNull(),
    rollbackPlan: jsonb('rollback_plan').notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    resultRef: jsonb('result_ref'),
    causationEventId: uuid('causation_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('agent_action_records_workspace_occurred_at_idx').on(table.workspaceId, table.occurredAt),
  ],
);
