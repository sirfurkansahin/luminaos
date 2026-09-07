import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listAgents, registerAgent } from '../lib/apiClient.js';

import type { Agent } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T3 PR7a (ADR-0037 §b/§d) -- mirrors `useMcpGrantsQuery.ts`'s exact
 * query-key/invalidation-by-prefix shape.
 */
export function useAgentsQuery(workspaceId: string): UseQueryResult<{ agents: Agent[] }> {
  return useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => listAgents(workspaceId),
  });
}

export function useRegisterAgentMutation(
  workspaceId: string,
): UseMutationResult<{ agent: Agent }, Error, { name: string; agentIdentifier: string }> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { name: string; agentIdentifier: string }) =>
      registerAgent(workspaceId, variables),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents', workspaceId] });
    },
  });
}
