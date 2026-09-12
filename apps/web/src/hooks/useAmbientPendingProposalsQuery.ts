import { useQuery } from '@tanstack/react-query';

import { listProposals } from '../lib/apiClient.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T9 PR2 (ADR-0043 Karar e) -- ambient "bekleyen öneri" badge data source.
 * Wraps the EXISTING `listProposals({ pendingOnly: true })` (F2-T16) with
 * ADR-0042's identical `refetchInterval`/`refetchIntervalInBackground: false`
 * client-poll pattern (`useLiveWidgetQuery.ts`) -- ZERO new backend endpoint,
 * ZERO new AI-triggering mechanism (ADR-0043 human decision 1).
 */
export const AMBIENT_BADGE_POLL_INTERVAL_MS = 45_000;
export const AMBIENT_BADGE_SAMPLE_LIMIT = 5;

export function useAmbientPendingProposalsQuery(
  workspaceId: string,
): UseQueryResult<{ count: number; hasMore: boolean }> {
  return useQuery({
    queryKey: ['ambientPendingProposals', workspaceId],
    queryFn: async () => {
      const { proposals, nextCursor } = await listProposals(workspaceId, {
        pendingOnly: true,
        limit: AMBIENT_BADGE_SAMPLE_LIMIT,
      });
      // ADR-0043 Bağlam #4/Karar e's explicit edge case: a `decidedAt: null`
      // proposal whose entire batch was 'act_and_notify' has `actions: []`
      // and requires ZERO human decisions -- it must NOT be counted here.
      const withPendingActions = proposals.filter(
        (proposal) => Array.isArray(proposal.actions) && proposal.actions.length > 0,
      );
      return { count: withPendingActions.length, hasMore: nextCursor !== undefined };
    },
    refetchInterval: AMBIENT_BADGE_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}
