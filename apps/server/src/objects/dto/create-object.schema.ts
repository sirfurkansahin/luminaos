import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/objects` request body.
 *
 * `.strict()` rejects unknown keys (mass-assignment protection), matching
 * `create-workspace.schema.ts`'s convention. Unlike that schema, `title` is
 * NOT `.trim().min(1)`'d here: title-requiredness is TYPE-parametric per
 * `packages/core-objects`' own `object-type-registry` (`task` requires a
 * non-empty title; `doc`/`note` do not — ADR-0003 "Tip genişletme"). Only a
 * genuinely wrong shape (missing/non-string `title`, unknown `objectType`)
 * is rejected at this DTO boundary; the real "is this title acceptable for
 * this object type" rule is enforced by the domain layer (`createObject`),
 * which is the single source of truth for it.
 */
export const createObjectSchema = z
  .object({
    objectType: z.enum(['task', 'doc', 'note', 'timeblock']),
    title: z.string(),
  })
  .strict();

export type CreateObjectInput = z.infer<typeof createObjectSchema>;
