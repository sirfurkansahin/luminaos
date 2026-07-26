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
