import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { useObjectsQuery, useSetFieldValuesMutation } from './useObjectsQuery.js';
import { patchFieldValues, postObjectsQuery } from '../lib/apiClient.js';

import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useObjectsQuery.ts to satisfy these tests, and add
 * `@tanstack/react-query` as a runtime dependency of apps/web/package.json —
 * it is not there yet, so this import will fail to resolve until then.
 * That's the expected TDD red state.):
 *
 *   export function useObjectsQuery(
 *     workspaceId: string,
 *     querySpec: QuerySpec,
 *   ): UseQueryResult<QueryResult>; // thin wrapper around
 *       // @tanstack/react-query's useQuery — the queryFn delegates to
 *       // apiClient.ts's postObjectsQuery(workspaceId, querySpec). The
 *       // exact queryKey shape is this hook's own choice, EXCEPT that it
 *       // MUST start with ['objects', workspaceId, ...] so that
 *       // useSetFieldValuesMutation's invalidation (below) can target it by
 *       // key prefix.
 *
 *   export function useSetFieldValuesMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<..., ..., { objectId: string; values: Record<string, unknown> }>;
 *       // wraps useMutation; mutationFn delegates to apiClient.ts's
 *       // patchFieldValues(workspaceId, variables.objectId, variables.values).
 *       // On success, calls queryClient.invalidateQueries with a filter
 *       // whose queryKey is (or starts with) ['objects', workspaceId, ...]
 *       // so any cached useObjectsQuery results for this workspace refetch.
 *       //
 *       // NOTE for implementer: the mutation variables shape
 *       // `{ objectId, values }` is this test file's design choice (not
 *       // independently pinned elsewhere) — flag to test-writer/caller if a
 *       // different shape is preferred before wiring UI call sites to it.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its contract is
 * pinned separately by apps/web/src/lib/apiClient.test.ts, not here.
 */

vi.mock('../lib/apiClient.js', () => ({
  postObjectsQuery: vi.fn(),
  patchFieldValues: vi.fn(),
}));

const mockedPostObjectsQuery = vi.mocked(postObjectsQuery);
const mockedPatchFieldValues = vi.mocked(patchFieldValues);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { queryClient, Wrapper };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useObjectsQuery', () => {
  const workspaceId = 'ws-1';
  const querySpec: QuerySpec = { objectType: 'task', filters: [] };

  it('resolves with the data returned by apiClient.postObjectsQuery on a successful query', async () => {
    const payload: QueryResult = { objects: [{ id: 'obj-1' } as unknown as ObjectWithFieldValues] };
    mockedPostObjectsQuery.mockResolvedValueOnce(payload);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useObjectsQuery(workspaceId, querySpec), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(payload);
    expect(mockedPostObjectsQuery).toHaveBeenCalledWith(workspaceId, querySpec);
  });

  it('transitions to isError with the thrown error when apiClient.postObjectsQuery rejects', async () => {
    const error = new Error('boom');
    mockedPostObjectsQuery.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useObjectsQuery(workspaceId, querySpec), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useSetFieldValuesMutation', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';
  const values = { status: 'done' };

  it('calls apiClient.patchFieldValues with the workspace id, object id and values on mutate', async () => {
    mockedPatchFieldValues.mockResolvedValueOnce({
      object: { id: objectId, fieldValues: values } as unknown as ObjectWithFieldValues,
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetFieldValuesMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ objectId, values });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedPatchFieldValues).toHaveBeenCalledWith(workspaceId, objectId, values);
  });

  it('invalidates cached ["objects", workspaceId, ...] queries once the mutation succeeds', async () => {
    mockedPatchFieldValues.mockResolvedValueOnce({
      object: { id: objectId, fieldValues: values } as unknown as ObjectWithFieldValues,
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetFieldValuesMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ objectId, values });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('objects');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});

/**
 * Contract under test for the next increment (not yet implemented):
 * useSetFieldValuesMutation must apply a TanStack Query optimistic-update
 * pattern:
 *   - onMutate: synchronously write the new field values into any cached
 *     ['objects', workspaceId, ...] query results (before the network call
 *     resolves), and return the previous cache snapshot as context so it
 *     can be restored on failure.
 *   - onError: restore the cache to the snapshot captured in onMutate.
 *   - onSuccess/onSettled: keep invalidating ['objects', workspaceId, ...]
 *     as before (regression — must not be dropped when optimistic update is
 *     added).
 * This is a red/TDD test block: it is expected to fail until the
 * implementer adds onMutate/onError to the hook.
 */
describe('useSetFieldValuesMutation — optimistic updates', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';
  const querySpec: QuerySpec = { objectType: 'task', filters: [] };
  const queryKey = ['objects', workspaceId, querySpec] as const;
  const originalFieldValues = { status: 'todo' };
  const newValues = { status: 'done' };

  function seedCache(queryClient: QueryClient): QueryResult {
    const payload: QueryResult = {
      objects: [
        { id: objectId, fieldValues: originalFieldValues } as unknown as ObjectWithFieldValues,
      ],
    };
    queryClient.setQueryData(queryKey, payload);
    return payload;
  }

  it('optimistically merges the new field values into the cached objects list in onMutate, before the mutation resolves', async () => {
    let resolvePatch: (value: { object: ObjectWithFieldValues }) => void = () => {
      throw new Error('resolvePatch called before assignment');
    };
    const pending = new Promise<{ object: ObjectWithFieldValues }>((resolve) => {
      resolvePatch = resolve;
    });
    mockedPatchFieldValues.mockReturnValueOnce(pending);

    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient);

    const { result } = renderHook(() => useSetFieldValuesMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ objectId, values: newValues });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    const cached = queryClient.getQueryData<QueryResult>(queryKey);
    const cachedObject = (cached as { objects: ObjectWithFieldValues[] }).objects.find(
      (obj) => obj.id === objectId,
    );
    expect(cachedObject?.fieldValues).toEqual({ ...originalFieldValues, ...newValues });

    // Resolve so the pending mutation doesn't leak into subsequent tests.
    await act(async () => {
      resolvePatch({
        object: { id: objectId, fieldValues: newValues } as unknown as ObjectWithFieldValues,
      });
      await pending;
    });
  });

  it('rolls back the cache to its pre-mutation snapshot in onError when patchFieldValues rejects', async () => {
    const error = new Error('network down');
    mockedPatchFieldValues.mockRejectedValueOnce(error);

    const { queryClient, Wrapper } = createWrapper();
    const original = seedCache(queryClient);

    const { result } = renderHook(() => useSetFieldValuesMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ objectId, values: newValues });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(original);
  });

  it('still invalidates cached ["objects", workspaceId, ...] queries after a successful optimistic mutation (regression)', async () => {
    mockedPatchFieldValues.mockResolvedValueOnce({
      object: { id: objectId, fieldValues: newValues } as unknown as ObjectWithFieldValues,
    });

    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetFieldValuesMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ objectId, values: newValues });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('objects');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});
