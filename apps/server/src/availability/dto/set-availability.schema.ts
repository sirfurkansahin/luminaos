import { z } from 'zod';

/**
 * Validates a `PUT /workspaces/:workspaceId/availability` request body.
 * `.strict()` rejects unknown keys (mass-assignment protection), matching
 * `../../calendar/dto/connect-calendar-account.schema.ts`'s convention.
 */
export const setAvailabilitySchema = z
  .object({
    status: z.enum(['available', 'focus', 'ooo']),
    until: z.iso.datetime().optional(),
  })
  .strict();

export type SetAvailabilityInput = z.infer<typeof setAvailabilitySchema>;
