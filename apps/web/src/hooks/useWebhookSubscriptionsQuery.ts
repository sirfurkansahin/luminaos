import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
} from '../lib/apiClient.js';

import type { CreatedWebhookSubscription, WebhookSubscription } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T16 PR4 (ADR-0033 §g) -- mirrors `useMcpGrantsQuery.ts`'s exact
 * query-key/invalidation shape.
 */
export function useWebhookSubscriptionsQuery(
  workspaceId: string,
): UseQueryResult<{ subscriptions: WebhookSubscription[] }> {
  return useQuery({
    queryKey: ['webhook-subscriptions', workspaceId],
    queryFn: () => listWebhookSubscriptions(workspaceId),
  });
}

function invalidateWebhookSubscriptions(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions', workspaceId] });
}

export function useCreateWebhookSubscriptionMutation(
  workspaceId: string,
): UseMutationResult<
  { subscription: CreatedWebhookSubscription },
  Error,
  { targetUrl: string; eventTypes: string[] }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { targetUrl: string; eventTypes: string[] }) =>
      createWebhookSubscription(workspaceId, variables),
    onSuccess: () => {
      invalidateWebhookSubscriptions(queryClient, workspaceId);
    },
  });
}

export function useDeleteWebhookSubscriptionMutation(
  workspaceId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (subscriptionId: string) => deleteWebhookSubscription(workspaceId, subscriptionId),
    onSuccess: () => {
      invalidateWebhookSubscriptions(queryClient, workspaceId);
    },
  });
}
