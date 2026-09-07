import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * `dm_messages` — the read model for F3-T3 PR5's event-sourced 1:1
 * user<->agent DM thread (`DirectMessageSent`, ADR-0037 §4). One row per
 * message (user-authored or agent-authored reply), scoped to a
 * `(workspaceId, userId, agentIdentifier)` triple — mirrors
 * `memory_access_policies.ts`'s per-triple scoping but WITHOUT a unique
 * constraint (a thread accumulates many messages over time, unlike a
 * single grant/revoke row).
 *
 * `agentIdentifier`/`proposalId` are deliberately bare `varchar`/no FK —
 * mirrors `mention_actions.ts`'s "read-model-to-read-model reference, no
 * FK" convention (`proposalId` points at `command_proposals.id`, whose own
 * existence/workspace-scoping is enforced at the application level by
 * `CommandsService`, not the database).
 */
export const dmMessages = pgTable(
  'dm_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    sender: varchar('sender', { length: 10 }).notNull(), // 'user' | 'agent'
    body: text('body').notNull(),
    proposalId: varchar('proposal_id', { length: 36 }), // nullable, bare pointer into command_proposals.id
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('dm_messages_workspace_user_agent_created_at_idx').on(
      table.workspaceId,
      table.userId,
      table.agentIdentifier,
      table.createdAt,
    ),
  ],
);
