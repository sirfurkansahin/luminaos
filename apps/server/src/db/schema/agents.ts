import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `agents` — the read model for F3-T3's event-sourced `Agent` entity
 * (`AgentRegistered`/`AgentDeactivated`), mirroring
 * `automation-triggers.ts`'s exact conventions (ADR-0037 Karar b): `id` is a
 * ULID (business identity, `varchar(26)`), `stream_id` is the UUID
 * event-stream identity — but unlike `automation_triggers`'s stable
 * per-entity stream reused across updates, every new `Agent` gets a FRESH
 * `randomUUID()` stream (a toggle-free, freshly-minted identity, not a
 * deterministic composite key like `AgentPermissionManifest`'s).
 *
 * Uniqueness of `(workspace_id, name)` (case-insensitive) and
 * `(workspace_id, agent_identifier)` among ACTIVE rows is enforced at the
 * APPLICATION level only (in `AgentDirectoryService.register`'s
 * pre-check-then-append), mirroring `AutomationTriggersService`'s own
 * app-level-only uniqueness discipline — there is no partial unique DB index
 * here either. Known race caveat (same one `AutomationTriggersService`
 * documents): two concurrent `register` calls for the same
 * `(workspaceId, name)` could both pass the pre-check and both append,
 * yielding two active rows with colliding names. Accepted for this PR,
 * matching the sibling service's own accepted risk.
 */
export const agents = pgTable(
  'agents',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 32 }).notNull(), // matches registerAgentSchema's `^[A-Za-z0-9_-]{2,32}$`
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('agents_workspace_id_lifecycle_idx').on(table.workspaceId, table.lifecycle),
    index('agents_workspace_id_name_idx').on(table.workspaceId, table.name),
    index('agents_workspace_id_agent_identifier_idx').on(table.workspaceId, table.agentIdentifier),
  ],
);
