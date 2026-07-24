import { z } from 'zod';

/**
 * Validates a `PATCH /workspaces/:workspaceId/objects/:objectId` request
 * body. Mirrors `create-object.schema.ts`'s reasoning: `title`-emptiness is
 * parametric per object type, so it is not rejected here — the domain
 * layer's `renameObject` enforces the real rule.
 */
export const renameObjectSchema = z
  .object({
    title: z.string(),
  })
  .strict();

export type RenameObjectInput = z.infer<typeof renameObjectSchema>;
