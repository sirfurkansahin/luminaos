import { z } from 'zod';

/** `addChecklistItem`'s own domain-layer cap (`packages/core-objects/src/checklist-commands.ts`) — a valid permutation can never legitimately exceed this many ids, so bounding the array here rejects an oversized payload structurally before any DB work (security-review finding, F1-T10 PR6b). */
const MAX_CHECKLIST_ITEMS = 200;

/** A ULID is 26 characters; generously bounded well above that so a malformed/oversized id string can't slip through as a `.max()`-less value. */
const MAX_ITEM_ID_LENGTH = 100;

/**
 * Validates a `POST /workspaces/:workspaceId/objects/:objectId/checklist/reorder`
 * request body. Permutation validity (every id present, no extras, no
 * duplicates) is not checked here — that is `reorderChecklistItem`'s own
 * domain-layer rule (`@luminaos/core-objects`), not this DTO boundary's.
 */
export const reorderChecklistSchema = z
  .object({
    orderedItemIds: z.array(z.string().min(1).max(MAX_ITEM_ID_LENGTH)).max(MAX_CHECKLIST_ITEMS),
  })
  .strict();

export type ReorderChecklistInput = z.infer<typeof reorderChecklistSchema>;
