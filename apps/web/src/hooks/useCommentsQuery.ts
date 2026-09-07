import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listComments, postComment } from '../lib/apiClient.js';

import type { Comment } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T3 PR7a (ADR-0037 §c) -- mirrors `useProposalsQuery.ts`'s exact
 * query-key/invalidation-by-prefix shape.
 */
export function useCommentsQuery(
  workspaceId: string,
  objectId: string,
): UseQueryResult<{ comments: Comment[] }> {
  return useQuery({
    queryKey: ['comments', workspaceId, objectId],
    queryFn: () => listComments(workspaceId, objectId),
  });
}

export function usePostCommentMutation(
  workspaceId: string,
  objectId: string,
): UseMutationResult<{ comment: Comment }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: string) => postComment(workspaceId, objectId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comments', workspaceId, objectId] });
    },
  });
}
