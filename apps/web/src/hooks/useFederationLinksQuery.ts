import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  acceptFederationLink,
  initiateFederationLink,
  listFederationLinks,
  revokeFederationLink,
} from '../lib/apiClient.js';

import type { FederationLink } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T14 PR3 (ADR-0048 §b/§c) -- mirrors `useAutonomyTierSettingsQuery.ts`'s
 * exact query-key/invalidation shape. Query key is `['federation-links',
 * workspaceId]`.
 */
export function useFederationLinksQuery(
  workspaceId: string,
): UseQueryResult<{ links: FederationLink[] }> {
  return useQuery({
    queryKey: ['federation-links', workspaceId],
    queryFn: () => listFederationLinks(workspaceId),
  });
}

export function useInitiateFederationLinkMutation(
  workspaceId: string,
): UseMutationResult<{ link: FederationLink }, Error, { counterpartWorkspaceId: string }> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { counterpartWorkspaceId: string }) =>
      initiateFederationLink(workspaceId, variables.counterpartWorkspaceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['federation-links', workspaceId] });
    },
  });
}

export function useAcceptFederationLinkMutation(
  workspaceId: string,
): UseMutationResult<{ link: FederationLink }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (linkId: string) => acceptFederationLink(workspaceId, linkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['federation-links', workspaceId] });
    },
  });
}

export function useRevokeFederationLinkMutation(
  workspaceId: string,
): UseMutationResult<{ link: FederationLink }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (linkId: string) => revokeFederationLink(workspaceId, linkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['federation-links', workspaceId] });
    },
  });
}
