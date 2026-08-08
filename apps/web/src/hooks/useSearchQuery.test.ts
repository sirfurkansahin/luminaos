import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSearchQuery } from './useSearchQuery.js';
import { searchWorkspace } from '../lib/apiClient.js';

import type { SearchResult } from '../lib/apiClient.js';

/**
 * F1-T13 PR6 (ADR-0013) — TDD red step. Contract under test (not yet
 * implemented — implementer must build apps/web/src/hooks/useSearchQuery.ts
 * to satisfy these tests):
 *
 *   export function useSearchQuery(
 *     workspaceId: string,
 *     query: string,
 *   ): UseQueryResult<{ results: SearchResult[] }>;
 *       // thin wrapper around @tanstack/react-query's useQuery — the
 *       // queryFn delegates to apiClient.ts's searchWorkspace(workspaceId,
 *       // query). Mirrors useObjectQuery's `enabled`-flag pattern
 *       // (apps/web/src/hooks/useObjectsQuery.ts): `enabled:
 *       // query.trim().length > 0` so an empty/whitespace-only query never
 *       // fires a request. queryKey MUST start with ['search', workspaceId,
 *       // ...] per this codebase's key-prefix convention (see
 *       // useObjectsQuery's own doc comment re: ['objects', workspaceId,
 *       // ...]).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * is pinned separately by apiClient.search.test.ts, not here.
 */

vi.mock('../lib/apiClient.js', () => ({
  searchWorkspace: vi.fn(),
}));

const mockedSearchWorkspace = vi.mocked(searchWorkspace);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
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

describe('useSearchQuery', () => {
  const workspaceId = 'ws-1';

  it('does not call searchWorkspace and is disabled when query is empty', () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSearchQuery(workspaceId, ''), { wrapper: Wrapper });

    expect(result.current.isFetching).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedSearchWorkspace).not.toHaveBeenCalled();
  });

  it('does not call searchWorkspace and is disabled when query is whitespace-only', () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSearchQuery(workspaceId, '   '), { wrapper: Wrapper });

    expect(result.current.isFetching).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedSearchWorkspace).not.toHaveBeenCalled();
  });

  it('calls searchWorkspace and populates data on a non-empty query', async () => {
    const results: SearchResult[] = [
      { objectId: 'obj-1', title: 'Q3 Roadmap', type: 'task', score: 0.9 },
    ];
    mockedSearchWorkspace.mockResolvedValueOnce({ results });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSearchQuery(workspaceId, 'roadmap'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ results });
    expect(mockedSearchWorkspace).toHaveBeenCalledWith(workspaceId, 'roadmap');
  });

  it('uses a queryKey starting with ["search", workspaceId, ...] and refetches when query changes', async () => {
    mockedSearchWorkspace.mockResolvedValue({ results: [] });
    const { Wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useSearchQuery(workspaceId, query),
      { wrapper: Wrapper, initialProps: { query: 'roadmap' } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(mockedSearchWorkspace).toHaveBeenCalledTimes(1);
    expect(mockedSearchWorkspace).toHaveBeenNthCalledWith(1, workspaceId, 'roadmap');

    rerender({ query: 'sprint' });

    await waitFor(() => {
      expect(mockedSearchWorkspace).toHaveBeenCalledTimes(2);
    });
    expect(mockedSearchWorkspace).toHaveBeenNthCalledWith(2, workspaceId, 'sprint');
  });

  it('refetches when workspaceId changes for the same query', async () => {
    mockedSearchWorkspace.mockResolvedValue({ results: [] });
    const { Wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ wsId }: { wsId: string }) => useSearchQuery(wsId, 'roadmap'),
      { wrapper: Wrapper, initialProps: { wsId: 'ws-1' } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(mockedSearchWorkspace).toHaveBeenCalledTimes(1);

    rerender({ wsId: 'ws-2' });

    await waitFor(() => {
      expect(mockedSearchWorkspace).toHaveBeenCalledTimes(2);
    });
    expect(mockedSearchWorkspace).toHaveBeenNthCalledWith(2, 'ws-2', 'roadmap');
  });
});
