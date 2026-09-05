import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/objects/:objectId/comments`
 * request body (F3-T3, ADR-0037 Karar c). `objectId` comes from the route
 * param, not the body — only `body` (the comment text) is submitted here.
 * `MAX_COMMENT_BODY_LENGTH` mirrors `add-checklist-item.schema.ts`'s
 * `MAX_CHECKLIST_ITEM_TEXT_LENGTH` bound (security-review finding, F3-T3
 * PR2) — without it an oversized body becomes an immutable event-store
 * payload with no edit/delete path to reclaim the space.
 */
export const MAX_COMMENT_BODY_LENGTH = 2000;

export const createCommentSchema = z
  .object({
    body: z.string().min(1).max(MAX_COMMENT_BODY_LENGTH),
  })
  .strict();

export type CreateCommentBody = z.infer<typeof createCommentSchema>;
