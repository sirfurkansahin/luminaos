import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { MemoryRecord } from '@luminaos/memory';

import {
  createMemoryRecord,
  deleteMemoryRecord,
  getMemoryRecords,
  updateMemoryRecord,
} from '../lib/apiClient.js';

import type { MemoryRecordCreateInput, MemoryRecordUpdateInput } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

export function useMemoryRecordsQuery(
  workspaceId: string,
): UseQueryResult<{ records: MemoryRecord[] }> {
  return useQuery({
    queryKey: ['memoryRecords', workspaceId],
    queryFn: () => getMemoryRecords(workspaceId),
  });
}

/**
 * Invalidates every cached `useMemoryRecordsQuery` result for this workspace
 * — mirrors useSavedViewsQuery.ts's `invalidateSavedViews` precedent.
 */
function invalidateMemoryRecords(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['memoryRecords', workspaceId] });
}

export function useCreateMemoryRecordMutation(
  workspaceId: string,
): UseMutationResult<{ record: MemoryRecord }, Error, MemoryRecordCreateInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: MemoryRecordCreateInput) => createMemoryRecord(workspaceId, input),
    onSuccess: () => {
      invalidateMemoryRecords(queryClient, workspaceId);
    },
  });
}

export function useUpdateMemoryRecordMutation(
  workspaceId: string,
): UseMutationResult<
  { record: MemoryRecord },
  Error,
  { recordId: string; input: MemoryRecordUpdateInput }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ recordId, input }: { recordId: string; input: MemoryRecordUpdateInput }) =>
      updateMemoryRecord(workspaceId, recordId, input),
    onSuccess: () => {
      invalidateMemoryRecords(queryClient, workspaceId);
    },
  });
}

export function useDeleteMemoryRecordMutation(
  workspaceId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (recordId: string) => deleteMemoryRecord(workspaceId, recordId),
    onSuccess: () => {
      invalidateMemoryRecords(queryClient, workspaceId);
    },
  });
}
