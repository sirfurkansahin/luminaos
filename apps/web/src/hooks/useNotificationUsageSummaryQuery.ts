import { useQuery } from '@tanstack/react-query';

import { getNotificationUsageSummary } from '../lib/apiClient.js';

import type { NotificationUsageSummary } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T13 PR3 (ADR-0047 Karar f/g) -- CANLI/derived, read-only, no mutation
 * counterpart (mirrors `useAgentActionRecordsQuery.ts`'s equivalent single-
 * query shape). Query key is `['notification-usage-summary', workspaceId,
 * userId]`.
 */
export function useNotificationUsageSummaryQuery(
  workspaceId: string,
  userId: string,
): UseQueryResult<{ summary: NotificationUsageSummary }> {
  return useQuery({
    queryKey: ['notification-usage-summary', workspaceId, userId],
    queryFn: () => getNotificationUsageSummary(workspaceId, userId),
  });
}
