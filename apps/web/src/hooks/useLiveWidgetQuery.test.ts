import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { useLiveWidgetQuery, WIDGET_REFRESH_INTERVAL_MS } from './useLiveWidgetQuery.js';
import { postObjectsQuery } from '../lib/apiClient.js';

import type { QueryResult } from '../lib/apiClient.js';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar e, insan kararı 3/4, spec
 * Kabul Kriterleri) -- TDD red step. Contract under test (NEITHER
 * apps/web/src/hooks/useLiveWidgetQuery.ts NOR its `WIDGET_REFRESH_INTERVAL_MS`
 * export exist yet -- implementer must build both):
 *
 *   // apps/web/src/hooks/useLiveWidgetQuery.ts
 *   export const WIDGET_REFRESH_INTERVAL_MS: number; // 30_000-60_000 range
 *       // (ADR-0042 insan kararı 4's own suggested default is 45_000 -- this
 *       // file asserts the RANGE plus internal consistency with the actual
 *       // useQuery call, never a hardcoded literal, so the implementer's
 *       // exact choice and this test's assertion cannot drift apart).
 *   export function useLiveWidgetQuery(
 *     workspaceId: string,
 *     querySpec: QuerySpec | undefined,
 *   ): UseQueryResult<QueryResult>;
 *       // thin wrapper around @tanstack/react-query's useQuery, mirroring
 *       // useObjectsQuery.ts's useObjectQuery `enabled` convention -- the
 *       // queryFn delegates to apiClient.ts's EXISTING
 *       // postObjectsQuery(workspaceId, querySpec), `enabled: querySpec !==
 *       // undefined`, `refetchInterval: WIDGET_REFRESH_INTERVAL_MS`,
 *       // `refetchIntervalInBackground: false` (ADR-0042 Karar e's own code
 *       // sketch).
 *
 * apiClient.ts is mocked wholesale (vi.mock), matching every other hook test
 * in this directory's established convention. `@tanstack/react-query`'s own
 * `useQuery` export is wrapped with `vi.fn(actual.useQuery)` (NOT replaced --
 * it still delegates to the real implementation) purely so the exact options
 * object the hook passes to `useQuery` (`enabled`/`refetchInterval`/
 * `refetchIntervalInBackground`) can be inspected directly -- `result.current`
 * from `renderHook` does not expose the internal query options otherwise.
 */

vi.mock('../lib/apiClient.js', () => ({
  postObjectsQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
  };
});

const mockedPostObjectsQuery = vi.mocked(postObjectsQuery);
const mockedUseQuery = vi.mocked(useQuery);

interface UseQueryOptionsShape {
  enabled?: boolean;
  refetchInterval?: number;
  refetchIntervalInBackground?: boolean;
}

function lastUseQueryOptions(): UseQueryOptionsShape | undefined {
  const lastCall = mockedUseQuery.mock.calls.at(-1);
  return lastCall?.[0] as UseQueryOptionsShape | undefined;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { Wrapper };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WIDGET_REFRESH_INTERVAL_MS', () => {
  it('is within the ADR-0042-mandated 30s-60s refresh window (insan kararı 4)', () => {
    expect(WIDGET_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(WIDGET_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('useLiveWidgetQuery', () => {
  const workspaceId = 'ws-1';
  const querySpec: QuerySpec = {
    objectType: 'task',
    filters: [{ field: 'assignee', operator: 'equals', value: 'user-1' }],
  };

  it('is disabled and never calls postObjectsQuery when querySpec is undefined', () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useLiveWidgetQuery(workspaceId, undefined), {
      wrapper: Wrapper,
    });

    expect(mockedPostObjectsQuery).not.toHaveBeenCalled();
    expect(result.current.isFetching).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(lastUseQueryOptions()?.enabled).toBe(false);
  });

  it('calls postObjectsQuery with the workspace id and the exact querySpec once querySpec is provided', async () => {
    mockedPostObjectsQuery.mockResolvedValueOnce({ objects: [] } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useLiveWidgetQuery(workspaceId, querySpec), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedPostObjectsQuery).toHaveBeenCalledWith(workspaceId, querySpec);
    expect(lastUseQueryOptions()?.enabled).toBe(true);
  });

  it('passes refetchInterval equal to the exported WIDGET_REFRESH_INTERVAL_MS constant to the underlying useQuery call', async () => {
    mockedPostObjectsQuery.mockResolvedValueOnce({ objects: [] } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    renderHook(() => useLiveWidgetQuery(workspaceId, querySpec), { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockedUseQuery).toHaveBeenCalled();
    });

    expect(lastUseQueryOptions()?.refetchInterval).toBe(WIDGET_REFRESH_INTERVAL_MS);
  });

  it('passes refetchIntervalInBackground: false to the underlying useQuery call (insan kararı 4 -- no polling while the tab is backgrounded)', async () => {
    mockedPostObjectsQuery.mockResolvedValueOnce({ objects: [] } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    renderHook(() => useLiveWidgetQuery(workspaceId, querySpec), { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockedUseQuery).toHaveBeenCalled();
    });

    expect(lastUseQueryOptions()?.refetchIntervalInBackground).toBe(false);
  });
});
