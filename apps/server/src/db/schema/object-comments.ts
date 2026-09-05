import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `object_comments` — the read model for F3-T3's event-sourced `ObjectComment`
 * @mention surface on top of Lumina Objects (ADR-0037 Karar c). Mirrors
 * `agents.ts`'s exact conventions: `id` is a ULID (business identity,
 * `varchar(26)`), `stream_id` is the UUID event-stream identity — but unlike
 * `agents`'s per-entity stream reused for its own lifecycle events, EVERY
 * comment gets its own FRESH `randomUUID()` stream (a comment is never
 * updated in place; it is a single, immutable append). `objectId` is
 * deliberately a bare `varchar(26)` (NOT a foreign key to `objects_view`) —
 * mirrors the codebase's read-model-to-read-model reference convention
 * (comments are a purpose-built surface ON TOP of objects, not a column
 * folded into the object's own row) — existence/workspace-scoping is
 * enforced at the application level by `CommentsService` (a workspace-scoped
 * `SELECT` against `objects_view`, 404 on miss), same discipline as
 * `AgentDirectoryService.lookupStreamId`.
 *
 * `authorActor` is a jsonb snapshot of the `Actor` who wrote the comment.
 * `mentionedAgentIds` is a jsonb `string[]` — a creation-time SNAPSHOT of
 * resolved agent ids (ADR-0037 Karar c: "a live/dynamic reference, NEVER"),
 * mirroring `agent_permission_manifests.ts`'s own jsonb-array-for-open-list
 * convention (`actionTypes`) rather than a separate join table, since this
 * list is immutable once written and never queried by agent id directly.
 */
export const objectComments = pgTable(
  'object_comments',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectId: varchar('object_id', { length: 26 }).notNull(),
    authorActor: jsonb('author_actor').notNull(),
    body: text('body').notNull(),
    mentionedAgentIds: jsonb('mentioned_agent_ids').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('object_comments_workspace_id_object_id_created_at_idx').on(
      table.workspaceId,
      table.objectId,
      table.createdAt,
    ),
  ],
);
