import { z } from 'zod';

/** Caps how far apart `start`/`end` may be, so a caller can't trigger an unbounded O(n²) in-memory pairwise scan in `ConflictDetectionService` against their own (potentially large) set of timeblocks/cached events (security review, F1-T12 PR7). Self-scoped-only DoS, so a generous bound is fine -- one year comfortably covers any real Calendar view range. */
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Validates a `GET /workspaces/:workspaceId/calendar/conflicts` request's
 * query parameters -- both `start`/`end` are REQUIRED ISO-8601 datetime
 * strings. `.strict()` rejects unknown query keys, mirroring
 * `./list-calendar-events.schema.ts`'s identical convention.
 */
export const listConflictsSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  })
  .strict()
  .refine((value) => new Date(value.end).getTime() > new Date(value.start).getTime(), {
    message: 'end must be after start',
  })
  .refine(
    (value) => new Date(value.end).getTime() - new Date(value.start).getTime() <= MAX_RANGE_MS,
    { message: 'the requested range must not exceed 366 days' },
  );

export type ListConflictsQuery = z.infer<typeof listConflictsSchema>;
