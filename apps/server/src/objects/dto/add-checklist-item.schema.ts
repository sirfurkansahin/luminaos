import { z } from 'zod';

/** A checklist item's `text` has no domain-layer upper bound (`addChecklistItem` only checks emptiness) — capped here at the DTO boundary so an oversized value can never become an immutable event (security-review finding, F1-T10 PR6b), mirroring `field-type-registry.ts`'s `MAX_OPTION_LENGTH`-style defense-in-depth bounds elsewhere in this codebase. */
const MAX_CHECKLIST_ITEM_TEXT_LENGTH = 2000;

/**
 * Validates a `POST /workspaces/:workspaceId/objects/:objectId/checklist/items`
 * request body. `text`-emptiness is enforced here (unlike `rename-object.schema.ts`'s
 * deliberately-permissive `title`) because `text` has no parametric,
 * per-object-type meaning — `addChecklistItem`'s own domain-layer check is
 * the same rule, kept here too for a fast, structural 400 before any DB work.
 */
export const addChecklistItemSchema = z
  .object({
    text: z.string().min(1).max(MAX_CHECKLIST_ITEM_TEXT_LENGTH),
  })
  .strict();

export type AddChecklistItemInput = z.infer<typeof addChecklistItemSchema>;
