import { z } from 'zod';

/**
 * Validates a `POST /workspaces` request body.
 *
 * - `.strict()` rejects unknown keys (mass-assignment protection), matching
 *   the pattern used by `auth/dto/register.schema.ts`.
 * - `name` is trimmed before length validation so a client can't smuggle in
 *   a name that's all whitespace and pass the `min(1)` check.
 */
export const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
