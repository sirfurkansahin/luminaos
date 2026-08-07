import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/calendar/accounts` request body.
 *
 * - `.strict()` rejects unknown keys (mass-assignment protection), matching
 *   the pattern used by `../../workspaces/dto/create-workspace.schema.ts`.
 * - `provider` is restricted to the two providers this PR's mock OAuth flow
 *   supports (F1-T12 PR5a) — anything else (e.g. `"yahoo"`) is a 400.
 */
export const connectCalendarAccountSchema = z
  .object({
    provider: z.enum(['google', 'outlook']),
  })
  .strict();

export type ConnectCalendarAccountInput = z.infer<typeof connectCalendarAccountSchema>;
