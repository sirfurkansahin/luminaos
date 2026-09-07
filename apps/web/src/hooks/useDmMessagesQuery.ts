import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listDmMessages, sendDmMessage } from '../lib/apiClient.js';

import type { DmMessage } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T3 PR7b (ADR-0037 §d) -- mirrors `useCommentsQuery.ts`'s exact
 * query-key/invalidation-by-prefix shape.
 */
export function useDmMessagesQuery(
  workspaceId: string,
  agentIdentifier: string,
): UseQueryResult<{ messages: DmMessage[] }> {
  return useQuery({
    queryKey: ['dm-messages', workspaceId, agentIdentifier],
    queryFn: () => listDmMessages(workspaceId, agentIdentifier),
  });
}

export function useSendDmMessageMutation(
  workspaceId: string,
  agentIdentifier: string,
): UseMutationResult<{ userMessage: DmMessage; agentReply: DmMessage }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: string) => sendDmMessage(workspaceId, agentIdentifier, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dm-messages', workspaceId, agentIdentifier],
      });
    },
  });
}
