import { z } from 'zod';

/**
 * Validates a `PUT /workspaces/:workspaceId/task-autonomy-settings/:actionType`
 * request body (ADR-0039 Karar b/i). Shape-only (the 3-member tier enum) —
 * the governance-floor business rule (ADR-0039 Karar c) is enforced by
 * `AutonomyTierSettingsService.set`, not this DTO.
 */
export const setAutonomyTierSchema = z
  .object({
    tier: z.enum(['propose', 'approve_and_act', 'act_and_notify']),
  })
  .strict();

export type SetAutonomyTierInput = z.infer<typeof setAutonomyTierSchema>;
