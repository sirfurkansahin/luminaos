import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { QuerySpec } from '@luminaos/shared';

import { patchFieldValues, postObjectsQuery } from '../lib/apiClient.js';

import type { QueryResult } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

export function useObjectsQuery(
  workspaceId: string,
  querySpec: QuerySpec,
): UseQueryResult<QueryResult> {
  return useQuery({
    queryKey: ['objects', workspaceId, querySpec],
    queryFn: () => postObjectsQuery(workspaceId, querySpec),
  });
}

interface SetFieldValuesVariables {
  objectId: string;
  values: Record<string, unknown>;
}

export function useSetFieldValuesMutation(
  workspaceId: string,
): UseMutationResult<Awaited<ReturnType<typeof patchFieldValues>>, Error, SetFieldValuesVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ objectId, values }: SetFieldValuesVariables) =>
      patchFieldValues(workspaceId, objectId, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['objects', workspaceId] });
    },
  });
}
