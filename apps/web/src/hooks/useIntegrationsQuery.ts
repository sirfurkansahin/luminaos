import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { connectIntegration, disconnectIntegration, getIntegrations } from '../lib/apiClient.js';

import type { IntegrationConnectorStatus } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T10 PR1 (ADR-0026 §c/§n) -- mirrors `useMemoryRecordsQuery.ts`'s exact
 * query-key/invalidation shape.
 */
export function useIntegrationsQuery(
  workspaceId: string,
): UseQueryResult<{ connectors: IntegrationConnectorStatus[] }> {
  return useQuery({
    queryKey: ['integrations', workspaceId],
    queryFn: () => getIntegrations(workspaceId),
  });
}

function invalidateIntegrations(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['integrations', workspaceId] });
}

export function useConnectIntegrationMutation(
  workspaceId: string,
): UseMutationResult<{ authorizeUrl: string }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (connectorType: string) => connectIntegration(workspaceId, connectorType),
    onSuccess: () => {
      invalidateIntegrations(queryClient, workspaceId);
    },
  });
}

export function useDisconnectIntegrationMutation(
  workspaceId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (connectorType: string) => disconnectIntegration(workspaceId, connectorType),
    onSuccess: () => {
      invalidateIntegrations(queryClient, workspaceId);
    },
  });
}
