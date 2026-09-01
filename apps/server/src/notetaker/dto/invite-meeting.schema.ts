import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/meetings` request body
 * (ADR-0030 §i): only `meetingUrl` is accepted -- the server itself detects
 * the provider from the URL (`detectMeetingProvider`), never trusting a
 * client-declared `provider` field. `.strict()` rejects unknown keys
 * (mass-assignment protection), matching `create-object.schema.ts`'s
 * convention.
 */
export const inviteMeetingSchema = z
  .object({
    meetingUrl: z.string(),
  })
  .strict();

export type InviteMeetingInput = z.infer<typeof inviteMeetingSchema>;
