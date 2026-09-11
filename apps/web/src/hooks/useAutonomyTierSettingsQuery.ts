import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listAutonomyTierSettings, setAutonomyTier } from '../lib/apiClient.js';

import type { AutonomyTier, TaskAutonomySetting } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T5 PR3 (ADR-0039) -- mirrors `useTriggerSuggestionsQuery.ts`'s exact
 * query-key/invalidation shape. Query key is `['autonomy-tier-settings',
 * workspaceId]`.
 */
export function useAutonomyTierSettingsQuery(
  workspaceId: string,
): UseQueryResult<{ settings: TaskAutonomySetting[] }> {
  return useQuery({
    queryKey: ['autonomy-tier-settings', workspaceId],
    queryFn: () => listAutonomyTierSettings(workspaceId),
  });
}

export function useSetAutonomyTierMutation(
  workspaceId: string,
): UseMutationResult<
  { setting: TaskAutonomySetting },
  Error,
  { actionType: string; tier: AutonomyTier }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { actionType: string; tier: AutonomyTier }) =>
      setAutonomyTier(workspaceId, variables.actionType, variables.tier),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['autonomy-tier-settings', workspaceId] });
    },
  });
}
