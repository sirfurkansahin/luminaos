import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { QuerySpec } from '@luminaos/shared';

import { getObject, patchFieldValues, postObjectsQuery } from '../lib/apiClient.js';

import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';
import type { QueryKey, UseMutationResult, UseQueryResult } from '@tanstack/react-query';

export function useObjectsQuery(
  workspaceId: string,
  querySpec: QuerySpec,
): UseQueryResult<QueryResult> {
  return useQuery({
    queryKey: ['objects', workspaceId, querySpec],
    queryFn: () => postObjectsQuery(workspaceId, querySpec),
  });
}

// A deliberately narrower shape than the full `UseQueryResult<T>` discriminated
// union (which has ~20 required properties per member, e.g. `isPending`,
// `isFetching`, `status`) — TaskDetailPanel.test.tsx's `vi.mock` of this hook
// returns plain `{ data, isLoading, isError, error }` object literals without
// casting them, so `vi.mocked(useObjectQuery).mockReturnValue(...)`'s
// inferred parameter type must structurally accept exactly that. The real
// runtime value returned below (react-query's actual `UseQueryResult`) always
// has strictly more properties than this interface requires, so no cast is
// needed on the `return` side either — only the subset TaskDetailPanel.tsx
// itself reads (`data`/`isLoading`/`isError`) is part of this public contract.
export interface ObjectQueryResult {
  data: { object: ObjectWithFieldValues } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export function useObjectQuery(
  workspaceId: string,
  objectId: string | undefined,
): ObjectQueryResult {
  return useQuery({
    queryKey: ['object', workspaceId, objectId],
    queryFn: () => getObject(workspaceId, objectId as string),
    enabled: objectId !== undefined,
  });
}

interface SetFieldValuesVariables {
  objectId: string;
  values: Record<string, unknown>;
}

export interface OptimisticContext {
  objectId: string;
  changedKeys: string[];
  previousValues: Record<string, unknown>;
}

export function useSetFieldValuesMutation(
  workspaceId: string,
): UseMutationResult<
  Awaited<ReturnType<typeof patchFieldValues>>,
  Error,
  SetFieldValuesVariables,
  OptimisticContext
> {
  const queryClient = useQueryClient();
  const objectsQueryKey: QueryKey = ['objects', workspaceId];

  return useMutation({
    mutationFn: ({ objectId, values }: SetFieldValuesVariables) =>
      patchFieldValues(workspaceId, objectId, values),
    onMutate: async ({ objectId, values }) => {
      await queryClient.cancelQueries({ queryKey: objectsQueryKey });

      // Only the previous values of the specific keys this mutation is
      // about to change are captured — never a whole-query snapshot. Two
      // edits on different fields of the same object can be in flight at
      // once (e.g. two Table cells committed in quick succession); a
      // whole-snapshot rollback in onError would silently erase the other,
      // still-pending edit's optimistic write. A per-field revert only ever
      // touches what *this* mutation itself wrote.
      let previousValues: Record<string, unknown> = {};
      for (const [, data] of queryClient.getQueriesData<QueryResult>({
        queryKey: objectsQueryKey,
      })) {
        if (data === undefined || !('objects' in data)) {
          continue;
        }
        const found = data.objects.find((object) => object.id === objectId);
        if (found !== undefined) {
          previousValues = found.fieldValues;
          break;
        }
      }

      queryClient.setQueriesData<QueryResult>({ queryKey: objectsQueryKey }, (old) => {
        if (old === undefined || !('objects' in old)) {
          return old;
        }
        return {
          ...old,
          objects: old.objects.map((object) =>
            object.id === objectId
              ? { ...object, fieldValues: { ...object.fieldValues, ...values } }
              : object,
          ),
        };
      });

      return { objectId, changedKeys: Object.keys(values), previousValues };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      const { objectId, changedKeys, previousValues } = context;

      queryClient.setQueriesData<QueryResult>({ queryKey: objectsQueryKey }, (old) => {
        if (old === undefined || !('objects' in old)) {
          return old;
        }
        return {
          ...old,
          objects: old.objects.map((object) => {
            if (object.id !== objectId) {
              return object;
            }
            const revertedFieldValues = { ...object.fieldValues };
            for (const key of changedKeys) {
              revertedFieldValues[key] = previousValues[key];
            }
            return { ...object, fieldValues: revertedFieldValues };
          }),
        };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: objectsQueryKey });
    },
  });
}
