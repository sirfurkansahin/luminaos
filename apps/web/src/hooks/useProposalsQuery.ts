import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { decideProposal, listProposals, parseCommand } from '../lib/apiClient.js';

import type {
  CommandProposalSummary,
  DecideActionResult,
  ParseCommandResponse,
} from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T16 PR4 (ADR-0033 §g/§h) -- mirrors `useMcpGrantsQuery.ts`'s exact
 * query-key/invalidation shape, with the query key extended by `filter` so
 * distinct filters cache independently while still being invalidatable BY
 * PREFIX (`['proposals', workspaceId]`) from `useDecideProposalMutation`
 * below.
 */
export function useProposalsQuery(
  workspaceId: string,
  filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
): UseQueryResult<{ proposals: CommandProposalSummary[]; nextCursor?: string }> {
  return useQuery({
    queryKey: ['proposals', workspaceId, filter],
    queryFn: () => listProposals(workspaceId, filter),
  });
}

export function useDecideProposalMutation(
  workspaceId: string,
): UseMutationResult<
  { results: DecideActionResult[] },
  Error,
  { proposalId: string; decisions: { actionId: string; decision: 'approved' | 'rejected' }[] }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: {
      proposalId: string;
      decisions: { actionId: string; decision: 'approved' | 'rejected' }[];
    }) => decideProposal(workspaceId, variables.proposalId, variables.decisions),
    onSuccess: () => {
      // Invalidate BY PREFIX so every cached filter-variant of this
      // workspace's proposals query refetches, regardless of which one is
      // currently mounted.
      void queryClient.invalidateQueries({ queryKey: ['proposals', workspaceId] });
    },
  });
}

/**
 * F3-T9 PR2 (ADR-0043 Karar c) -- feeds `CommandPalette`'s "komutu çalıştır"
 * row. `onSuccess` invalidation is the EXACT SAME prefix call as
 * `useDecideProposalMutation` above, so `AutomationHistoryPanel`/the ambient
 * badge pick up the freshly parsed proposal without any extra plumbing.
 */
export function useParseCommandMutation(
  workspaceId: string,
): UseMutationResult<ParseCommandResponse, Error, { command: string; sourceObjectId?: string }> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { command: string; sourceObjectId?: string }) =>
      parseCommand(workspaceId, variables.command, variables.sourceObjectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proposals', workspaceId] });
    },
  });
}
