import { z } from 'zod';

/**
 * Validates a `GET /workspaces/:workspaceId/views?objectType=...` request's
 * query parameters. `.strict()` rejects unknown query keys, matching this
 * codebase's other DTO conventions (`list-objects.schema.ts`).
 */
export const listSavedViewsQuerySchema = z
  .object({
    objectType: z.string().min(1),
  })
  .strict();

export type ListSavedViewsQuery = z.infer<typeof listSavedViewsQuerySchema>;
