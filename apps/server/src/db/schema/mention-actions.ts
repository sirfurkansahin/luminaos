import { index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `mention_actions` — F3-T3 PR3's durable queue table (ADR-0037 Karar (c)/
 * (3)): one row per resolved, still-active agent mentioned in a
 * `CommentAdded` comment, enqueued by `MentionActionEnqueueProjection` and
 * drained by `MentionActionWorker`. Mirrors `webhook-deliveries.ts`'s exact
 * queue-table conventions (`status`/`attempts`/`nextAttemptAt`/`lastError`
 * shape, `nextAttemptAt` doubling as the claim-lease field with no separate
 * "claimedUntil" column).
 *
 * `commentId`/`objectId`/`agentIdentifier` are deliberately bare
 * `varchar`/no FK — mirrors `object_comments.objectId`'s "read-model-to-
 * read-model reference, no FK" convention; existence/workspace-scoping is
 * enforced at the application level (`MentionActionEnqueueProjection`'s own
 * `objects_view`/`agents` re-checks), not the database.
 */
export const mentionActions = pgTable(
  'mention_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    commentId: varchar('comment_id', { length: 26 }).notNull(),
    objectId: varchar('object_id', { length: 26 }).notNull(),
    objectType: varchar('object_type', { length: 50 }).notNull(),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'done' | 'failed'
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'), // nullable, sanitize edilmiş mesaj -- soru/gövde/yanit metni ASLA
    replyCommentId: varchar('reply_comment_id', { length: 26 }), // nullable
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('mention_actions_status_next_attempt_at_idx').on(table.status, table.nextAttemptAt),
  ],
);
