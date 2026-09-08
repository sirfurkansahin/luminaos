import { useQuery } from '@tanstack/react-query';

import { listAgentActionRecords } from '../lib/apiClient.js';

import type { AgentActionRecord } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T4 PR4 (ADR-0038 §h) -- read-only, no mutation counterpart (this
 * ledger has no write UI at all). Mirrors `useProposalsQuery`'s
 * `useQuery`-only shape.
 */
export function useAgentActionRecordsQuery(
  workspaceId: string,
): UseQueryResult<{ records: AgentActionRecord[] }> {
  return useQuery({
    queryKey: ['agentActionRecords', workspaceId],
    queryFn: () => listAgentActionRecords(workspaceId),
  });
}
