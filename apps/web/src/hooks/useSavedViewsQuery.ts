import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SavedView } from '@luminaos/core-objects';

import {
  createSavedView,
  deleteSavedView,
  getSavedViews,
  updateSavedView,
} from '../lib/apiClient.js';

import type { SavedViewCreateInput, SavedViewUpdateInput } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

export function useSavedViewsQuery(
  workspaceId: string,
  objectType: string,
): UseQueryResult<{ savedViews: SavedView[] }> {
  return useQuery({
    queryKey: ['savedViews', workspaceId, objectType],
    queryFn: () => getSavedViews(workspaceId, objectType),
  });
}

/**
 * Invalidates every cached `useSavedViewsQuery` result for this workspace —
 * deliberately by the `['savedViews', workspaceId]` key prefix (not the
 * full `[..., objectType]` key), so a create/update/delete for one
 * objectType also refreshes any other objectType's cached list sharing the
 * same workspace (no cross-objectType leakage risk since the server itself
 * still scopes by objectType — see useSavedViewsQuery.test.ts's contract
 * comment).
 */
function invalidateSavedViews(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['savedViews', workspaceId] });
}

export function useCreateSavedViewMutation(
  workspaceId: string,
): UseMutationResult<{ savedView: SavedView }, Error, SavedViewCreateInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SavedViewCreateInput) => createSavedView(workspaceId, input),
    onSuccess: () => {
      invalidateSavedViews(queryClient, workspaceId);
    },
  });
}

export function useUpdateSavedViewMutation(
  workspaceId: string,
): UseMutationResult<
  { savedView: SavedView },
  Error,
  { savedViewId: string; input: SavedViewUpdateInput }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ savedViewId, input }: { savedViewId: string; input: SavedViewUpdateInput }) =>
      updateSavedView(workspaceId, savedViewId, input),
    onSuccess: () => {
      invalidateSavedViews(queryClient, workspaceId);
    },
  });
}

export function useDeleteSavedViewMutation(
  workspaceId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (savedViewId: string) => deleteSavedView(workspaceId, savedViewId),
    onSuccess: () => {
      invalidateSavedViews(queryClient, workspaceId);
    },
  });
}
