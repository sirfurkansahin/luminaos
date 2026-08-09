import { z } from 'zod';

/**
 * Validates a `GET /workspaces/:workspaceId/export` request's query
 * parameters (F1-T18 PR1). `.strict()` rejects unknown query keys, matching
 * this codebase's other DTO conventions (see `list-objects.schema.ts`).
 *
 * `format` is a closed enum of only `'json'` in this PR — PR2 (`markdown`)
 * and PR3 (`ical`) extend this enum, per ADR-0016 §(c)'s single-endpoint
 * decision; a missing or unrecognized `format` (e.g. `'csv'`) is rejected
 * with a 400 rather than silently defaulting, since there is no sensible
 * default export format.
 *
 * `objectId` is optional: when present it narrows the export to a single
 * object (and only the relations/field-definitions touching it); when
 * absent, the whole workspace is exported (ADR-0016 §(c)).
 */
export const exportQuerySchema = z
  .object({
    format: z.enum(['json']),
    objectId: z.string().min(1).optional(),
  })
  .strict();

export type ExportQuery = z.infer<typeof exportQuerySchema>;
