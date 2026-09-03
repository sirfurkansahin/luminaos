import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  decideTriggerSuggestion,
  listTriggerSuggestions,
  runTriggerSuggestionsAnalysis,
} from '../lib/apiClient.js';

import type { TriggerTemplateSuggestionSummary } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T17 PR3 (ADR-0034) -- mirrors `useProposalsQuery.ts`'s exact query-key/
 * invalidation shape. Unlike `useProposalsQuery`, this query takes no filter
 * argument, so its key is simply `['trigger-suggestions', workspaceId]`.
 */
export function useTriggerSuggestionsQuery(
  workspaceId: string,
): UseQueryResult<{ suggestions: TriggerTemplateSuggestionSummary[] }> {
  return useQuery({
    queryKey: ['trigger-suggestions', workspaceId],
    queryFn: () => listTriggerSuggestions(workspaceId),
  });
}

export function useRunTriggerSuggestionsAnalysisMutation(
  workspaceId: string,
): UseMutationResult<{ suggestions: TriggerTemplateSuggestionSummary[] }, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => runTriggerSuggestionsAnalysis(workspaceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-suggestions', workspaceId] });
    },
  });
}

export function useDecideTriggerSuggestionMutation(
  workspaceId: string,
): UseMutationResult<
  { suggestion: TriggerTemplateSuggestionSummary },
  Error,
  { suggestionId: string; decision: 'approve' | 'reject' }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { suggestionId: string; decision: 'approve' | 'reject' }) =>
      decideTriggerSuggestion(workspaceId, variables.suggestionId, variables.decision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-suggestions', workspaceId] });
    },
  });
}
