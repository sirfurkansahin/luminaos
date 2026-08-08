import { useQuery } from '@tanstack/react-query';

import { searchWorkspace } from '../lib/apiClient.js';

import type { SearchResult } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

export function useSearchQuery(
  workspaceId: string,
  query: string,
): UseQueryResult<{ results: SearchResult[] }> {
  return useQuery({
    queryKey: ['search', workspaceId, query],
    queryFn: () => searchWorkspace(workspaceId, query),
    enabled: query.trim().length > 0,
  });
}
