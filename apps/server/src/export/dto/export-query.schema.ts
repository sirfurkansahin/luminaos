import { z } from 'zod';

/**
 * Validates a `GET /workspaces/:workspaceId/export` request's query
 * parameters (F1-T18 PR1/PR2). `.strict()` rejects unknown query keys,
 * matching this codebase's other DTO conventions (see
 * `list-objects.schema.ts`).
 *
 * `format` is a closed enum of `'json' | 'markdown' | 'ical'` (the `'ical'`
 * member added by PR3, per ADR-0016 §(c)'s single-endpoint decision); a
 * missing or unrecognized `format` (e.g. `'csv'`) is rejected with a 400
 * rather than silently defaulting, since there is no sensible default export
 * format.
 *
 * `objectId` is optional for `format: 'json'` and `format: 'ical'`
 * (whole-workspace export when absent -- ADR-0016 §(e): iCal export is
 * workspace-wide by default, same as JSON), but REQUIRED for
 * `format: 'markdown'` (ADR-0016 §(d): a single doc's Markdown body has no
 * sensible whole-workspace shape) — enforced by the `.refine()` below, which
 * must come AFTER `.strict()` since `.refine()` returns a wrapped
 * `ZodEffects` schema that no longer exposes `.strict()`.
 */
export const exportQuerySchema = z
  .object({
    format: z.enum(['json', 'markdown', 'ical']),
    objectId: z.string().min(1).optional(),
  })
  .strict()
  .refine((data) => data.format !== 'markdown' || data.objectId !== undefined, {
    message: 'objectId is required when format is "markdown"',
    path: ['objectId'],
  });

export type ExportQuery = z.infer<typeof exportQuerySchema>;
