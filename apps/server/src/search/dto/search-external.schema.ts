import { z } from 'zod';

import { MAX_QUERY_LENGTH } from './search-workspace.schema.js';

/**
 * Validates a `POST /workspaces/:workspaceId/search/external` request body
 * (F2-T11, ADR-0027 §c). Mirrors `./search-workspace.schema.ts`'s exact
 * `.strict()`/DoS-cap-via-validation-REJECTION convention -- reuses the same
 * `MAX_QUERY_LENGTH` cap rather than inventing a second one.
 */
export const searchExternalSchema = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_LENGTH),
  })
  .strict();

export type SearchExternalInput = z.infer<typeof searchExternalSchema>;
