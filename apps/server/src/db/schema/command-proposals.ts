import { jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `command_proposals` — the read model for F1-T16 PR4's `action-proposal`
 * event-sourced entity (`ActionsProposed`/`ActionsDecided`, ADR-0015 §a/§b),
 * mirroring `relations-view.ts`'s conventions: `id` is the `proposalId`
 * minted by `CommandsService.parse()` (business identity). `varchar(36)`
 * accommodates both a ULID (26 chars, this codebase's usual business-id
 * shape) and a full UUID (36 chars) — this table's own pinned integration
 * tests use a UUID as a stand-in `proposalId` at the projection layer,
 * independent of the ULID `CommandsService` mints in production
 * (`newObjectId()`). `stream_id` is the UUID event-stream identity of the
 * proposal's own dedicated `action-proposal` stream.
 *
 * `decisions`/`decided_at` start `NULL` on `ActionsProposed` and are
 * populated once (by `ActionsDecided`, PR5) — see
 * `ActionProposalProjection` for the exact insert/update split.
 */
export const commandProposals = pgTable('command_proposals', {
  id: varchar('id', { length: 36 }).primaryKey(),
  streamId: uuid('stream_id').notNull().unique(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  command: text('command').notNull(),
  sourceObjectId: varchar('source_object_id', { length: 26 }),
  actions: jsonb('actions').notNull(),
  decisions: jsonb('decisions'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});
