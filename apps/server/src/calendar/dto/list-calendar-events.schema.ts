import { z } from 'zod';

/**
 * Validates a `GET /workspaces/:workspaceId/calendar/events` request's query
 * parameters -- both `start`/`end` are REQUIRED ISO-8601 datetime strings.
 * `.strict()` rejects unknown query keys, matching this codebase's other
 * query-schema convention (see `../../objects/dto/list-objects.schema.ts`).
 */
export const listCalendarEventsSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  })
  .strict();

export type ListCalendarEventsQuery = z.infer<typeof listCalendarEventsSchema>;
