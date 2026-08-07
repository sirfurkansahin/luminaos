import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/objects/:objectId/timeblock`
 * request body. Mirrors `set-recurrence-rule.schema.ts`'s style -- only
 * basic shape validation here; deeper rules (e.g. `end` strictly after
 * `start`) are re-validated by the domain layer's `scheduleTimeBlock`, not
 * duplicated here beyond ISO-8601 datetime shape.
 */
export const scheduleTimeblockSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  })
  .strict();

export type ScheduleTimeblockInput = z.infer<typeof scheduleTimeblockSchema>;
