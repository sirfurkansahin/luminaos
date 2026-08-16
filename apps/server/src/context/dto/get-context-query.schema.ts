import { z } from 'zod';

/**
 * Validates a `GET /workspaces/:workspaceId/context/:objectId?sort=...`
 * request's query parameters (F2-T4, ADR-0021 Karar a/g). `sort` is
 * optional; the only supported value today is `'relevance'`
 * (ADR-0021). `.strict()` rejects unknown query keys, matching
 * `list-objects.schema.ts`'s convention.
 */
export const getContextQuerySchema = z
  .object({
    sort: z.enum(['relevance']).optional(),
  })
  .strict();

export type GetContextQuery = z.infer<typeof getContextQuerySchema>;
