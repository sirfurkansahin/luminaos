import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addFederationScopeObject,
  listFederationScopeObjects,
  removeFederationScopeObject,
} from '../lib/apiClient.js';

import type { FederationScopeObject } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T14 PR3 (ADR-0048 §e) -- mirrors `useFederationLinksQuery.ts`'s exact
 * query-key/invalidation shape. Query key is `['federation-scope',
 * workspaceId, linkId]`.
 */
export function useFederationScopeQuery(
  workspaceId: string,
  linkId: string,
): UseQueryResult<{ scopeObjects: FederationScopeObject[] }> {
  return useQuery({
    queryKey: ['federation-scope', workspaceId, linkId],
    queryFn: () => listFederationScopeObjects(workspaceId, linkId),
  });
}

export function useAddFederationScopeObjectMutation(
  workspaceId: string,
  linkId: string,
): UseMutationResult<{ scopeObject: FederationScopeObject }, Error, { objectId: string }> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { objectId: string }) =>
      addFederationScopeObject(workspaceId, linkId, variables.objectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['federation-scope', workspaceId, linkId] });
    },
  });
}

export function useRemoveFederationScopeObjectMutation(
  workspaceId: string,
  linkId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (objectId: string) => removeFederationScopeObject(workspaceId, linkId, objectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['federation-scope', workspaceId, linkId] });
    },
  });
}
