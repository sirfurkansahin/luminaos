import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listAgentActionRecords, undoAgentAction } from '../lib/apiClient.js';

import type { AgentActionRecord } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T4 PR4 (ADR-0038 §h) -- mirrors `useProposalsQuery`'s `useQuery`-only
 * shape. `useUndoAgentActionMutation` below (F3-T6 PR3) is this query's
 * only mutation counterpart, invalidating this exact query key on success.
 */
export function useAgentActionRecordsQuery(
  workspaceId: string,
): UseQueryResult<{ records: AgentActionRecord[] }> {
  return useQuery({
    queryKey: ['agentActionRecords', workspaceId],
    queryFn: () => listAgentActionRecords(workspaceId),
  });
}

/**
 * F3-T6 PR3 (ADR-0040 §d/e/f/g) -- undoes a delete-rollback-plan agent
 * action record, feeding `FlightRecorderPanel`'s "Geri al" button. Mirrors
 * `useSetAutonomyTierMutation`'s mutation shape, but with a bare-string
 * mutation variable.
 */
export function useUndoAgentActionMutation(
  workspaceId: string,
): UseMutationResult<{ status: 'undone' }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (recordId: string) => undoAgentAction(workspaceId, recordId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agentActionRecords', workspaceId] });
    },
  });
}
