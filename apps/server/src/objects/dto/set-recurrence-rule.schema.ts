import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/objects/:objectId/recurrence-rule`
 * request body. Mirrors `@luminaos/core-objects`'s `RecurrenceRule` shape and
 * `recurrence-rule-commands.ts`'s own `endDateSchema` (`z.iso.date()`) for
 * `endDate` — deeper rules (e.g. `interval >= 1`) are re-validated by the
 * domain layer's `setRecurrenceRule`, not duplicated here beyond basic shape.
 */
export const setRecurrenceRuleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1),
    byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
    endDate: z.iso.date().optional(),
  })
  .strict();

export type SetRecurrenceRuleInput = z.infer<typeof setRecurrenceRuleSchema>;
