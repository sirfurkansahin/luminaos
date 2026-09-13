import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getNotificationPreference, setNotificationPreference } from '../lib/apiClient.js';

import type { NotificationPreference, NotificationPreferenceInput } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T13 PR3 (ADR-0047 Karar b/i) -- mirrors `useAutonomyTierSettingsQuery.ts`'s
 * exact query-key/invalidation shape, but scoped per-`(workspaceId, userId)`
 * (a personal preference, categorically distinct from `TaskAutonomySetting`'s
 * per-`(workspaceId, actionType)` workspace policy, ADR-0047 Karar b/3).
 * Query key is `['notification-preference', workspaceId, userId]`.
 */
export function useNotificationPreferenceQuery(
  workspaceId: string,
  userId: string,
): UseQueryResult<{ preference: NotificationPreference | null }> {
  return useQuery({
    queryKey: ['notification-preference', workspaceId, userId],
    queryFn: () => getNotificationPreference(workspaceId, userId),
  });
}

export function useSetNotificationPreferenceMutation(
  workspaceId: string,
  userId: string,
): UseMutationResult<{ preference: NotificationPreference }, Error, NotificationPreferenceInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: NotificationPreferenceInput) =>
      setNotificationPreference(workspaceId, userId, variables),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['notification-preference', workspaceId, userId],
      });
    },
  });
}
