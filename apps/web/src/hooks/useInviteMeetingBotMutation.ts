import { useMutation } from '@tanstack/react-query';

import { inviteMeetingBot } from '../lib/apiClient.js';

import type { InviteMeetingBotResult } from '../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F2-T13 PR5 (ADR-0030 §i/§j) -- ad hoc "invite a notetaker bot" mutation.
 * Mirrors `useMcpGrantsQuery.ts`'s mutation shape exactly. No query
 * invalidation -- there is no "list of invited meetings" view yet to
 * invalidate.
 */
export function useInviteMeetingBotMutation(
  workspaceId: string,
): UseMutationResult<InviteMeetingBotResult, Error, string> {
  return useMutation({
    mutationFn: (meetingUrl: string) => inviteMeetingBot(workspaceId, meetingUrl),
  });
}
