import { useQuery } from '@tanstack/react-query';

import { searchExternalWorkspace } from '../lib/apiClient.js';

import type { ConnectedSearchResponse } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

export function useExternalSearchQuery(
  workspaceId: string,
  query: string,
): UseQueryResult<ConnectedSearchResponse> {
  return useQuery({
    queryKey: ['search-external', workspaceId, query],
    queryFn: () => searchExternalWorkspace(workspaceId, query),
    enabled: query.trim().length > 0,
  });
}
