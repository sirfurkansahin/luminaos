import { z } from 'zod';

/**
 * DoS-cap-via-validation-REJECTION convention (mirrors
 * `../../calendar/dto/list-conflicts.schema.ts`): a search box query is never
 * legitimately longer than this, so anything beyond it is a 400, never
 * silently truncated.
 */
export const MAX_QUERY_LENGTH = 200;

/**
 * A single `POST /workspaces/:workspaceId/search` request can never ask for
 * more than this many results — beyond this is a 400 (rejected), not
 * silently clamped down to the cap, same reasoning as `MAX_QUERY_LENGTH`.
 */
export const MAX_LIMIT = 50;

/** Applied when the caller omits `limit` entirely. */
export const DEFAULT_LIMIT = 10;

/**
 * Validates a `POST /workspaces/:workspaceId/search` request body.
 * `.strict()` rejects unknown body keys, mirroring
 * `../../calendar/dto/list-conflicts.schema.ts`'s identical convention.
 */
export const searchWorkspaceSchema = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_LENGTH),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

export type SearchWorkspaceInput = z.infer<typeof searchWorkspaceSchema>;
