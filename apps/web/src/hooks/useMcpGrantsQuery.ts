import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createMcpGrant, listMcpGrants, revokeMcpGrant } from '../lib/apiClient.js';

import type { CreateMcpClientGrantResult, McpClientGrant } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T12 PR2 (ADR-0028 §k/§l) -- mirrors `useIntegrationsQuery.ts`'s exact
 * query-key/invalidation shape.
 */
export function useMcpGrantsQuery(
  workspaceId: string,
): UseQueryResult<{ grants: McpClientGrant[] }> {
  return useQuery({
    queryKey: ['mcp-grants', workspaceId],
    queryFn: () => listMcpGrants(workspaceId),
  });
}

function invalidateMcpGrants(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['mcp-grants', workspaceId] });
}

export function useCreateMcpGrantMutation(
  workspaceId: string,
): UseMutationResult<
  CreateMcpClientGrantResult,
  Error,
  { name: string; expiresAtDays: 30 | 90 | 365 }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ name, expiresAtDays }: { name: string; expiresAtDays: 30 | 90 | 365 }) =>
      createMcpGrant(workspaceId, name, expiresAtDays),
    onSuccess: () => {
      invalidateMcpGrants(queryClient, workspaceId);
    },
  });
}

export function useRevokeMcpGrantMutation(
  workspaceId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (grantId: string) => revokeMcpGrant(workspaceId, grantId),
    onSuccess: () => {
      invalidateMcpGrants(queryClient, workspaceId);
    },
  });
}
