import { z } from 'zod';

/**
 * Validates a `POST /webhooks/notetaker` request body (ADR-0030 §f/§g): the
 * bot vendor reports a `providerMeetingRef` (the webhook's matching key, ADR-0030
 * §d) plus the new status and, optionally, the transcript/recording URL once
 * the meeting has been processed. `transcriptText`/`providerRecordingUrl` are
 * `nullable().optional()` -- both an omitted key (partial update, ADR-0030 §g)
 * and an explicit `null` are valid shapes; `MeetingsService.applyWebhookUpdate`
 * distinguishes key-presence from key-absence for its own partial-update
 * semantics.
 */
export const notetakerWebhookSchema = z.object({
  providerMeetingRef: z.string().min(1),
  status: z.enum(['kaydedildi', 'basarisiz']),
  transcriptText: z.string().nullable().optional(),
  providerRecordingUrl: z.string().nullable().optional(),
});

export type NotetakerWebhookInput = z.infer<typeof notetakerWebhookSchema>;
