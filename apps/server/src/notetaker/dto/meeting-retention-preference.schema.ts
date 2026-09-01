import { z } from 'zod';

/**
 * Validates a `PUT /workspaces/:workspaceId/meeting-retention-preference`
 * request body (ADR-0031 §a): the 3-value `meeting_retention_mode` enum,
 * `.strict()` rejects unknown keys -- mirrors `invite-meeting.schema.ts`'s
 * convention.
 */
export const meetingRetentionPreferenceSchema = z
  .object({
    mode: z.enum(['recording-reference', 'transcript-only', 'summary-only']),
  })
  .strict();

export type MeetingRetentionPreferenceInput = z.infer<typeof meetingRetentionPreferenceSchema>;
