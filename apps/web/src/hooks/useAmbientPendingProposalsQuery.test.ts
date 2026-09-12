import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AMBIENT_BADGE_POLL_INTERVAL_MS,
  AMBIENT_BADGE_SAMPLE_LIMIT,
  useAmbientPendingProposalsQuery,
} from './useAmbientPendingProposalsQuery.js';
import { listProposals } from '../lib/apiClient.js';

import type { CommandProposalSummary } from '../lib/apiClient.js';

/**
 * F3-T9 PR2 (ADR-0043 Karar e, spec `docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md`
 * Kabul Kriterleri) — TDD red step. NEITHER
 * `apps/web/src/hooks/useAmbientPendingProposalsQuery.ts` NOR any of its
 * exports exist yet — implementer must build:
 *
 *   export const AMBIENT_BADGE_POLL_INTERVAL_MS: number; // ADR's own 45_000
 *   export const AMBIENT_BADGE_SAMPLE_LIMIT: number; // ADR pins this to 5
 *   export function useAmbientPendingProposalsQuery(
 *     workspaceId: string,
 *   ): UseQueryResult<{ count: number; hasMore: boolean }>;
 *       // queryFn calls listProposals(workspaceId, { pendingOnly: true, limit:
 *       // AMBIENT_BADGE_SAMPLE_LIMIT }); `count` is the number of returned
 *       // proposals with `actions.length > 0` (ADR-0043 Karar e's explicit
 *       // edge case: a decidedAt:null proposal whose entire batch was
 *       // 'act_and_notify' has actions:[] and must NOT be counted, since it
 *       // requires ZERO human decisions); `hasMore` is
 *       // `nextCursor !== undefined`. `refetchInterval:
 *       // AMBIENT_BADGE_POLL_INTERVAL_MS`, `refetchIntervalInBackground:
 *       // false` (ADR-0042's identical polling precedent, `useLiveWidgetQuery.ts`).
 *
 * apiClient.ts is mocked wholesale (vi.mock), matching every other hook test
 * in this directory. `@tanstack/react-query`'s own `useQuery` export is
 * wrapped with `vi.fn(actual.useQuery)` (NOT replaced) purely so the exact
 * options object passed to `useQuery` can be inspected directly — mirrors
 * `useLiveWidgetQuery.test.ts`'s exact technique.
 */

vi.mock('../lib/apiClient.js', () => ({
  listProposals: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
  };
});

const mockedListProposals = vi.mocked(listProposals);
const mockedUseQuery = vi.mocked(useQuery);

interface UseQueryOptionsShape {
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

function makeProposalFixture(
  overrides: Partial<CommandProposalSummary> = {},
): CommandProposalSummary {
  return {
    id: 'proposal-1',
    workspaceId: 'ws-1',
    command: 'Ayşe için görev oluştur',
    sourceObjectId: null,
    actions: [
      {
        actionId: 'action-1',
        type: 'createTask',
        intent: "Ayşe için 'Rapor gönder' görevi oluştur",
        rationale: 'Komutta belirtildi',
        resources: [],
        rollbackNote: 'Görev silinebilir',
        params: {},
      },
    ],
    decisions: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AMBIENT_BADGE_SAMPLE_LIMIT', () => {
  it('is exactly 5 (ADR-0043 Karar e -- enough to show "5+" without a full count)', () => {
    expect(AMBIENT_BADGE_SAMPLE_LIMIT).toBe(5);
  });
});

describe('useAmbientPendingProposalsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls listProposals with { pendingOnly: true, limit: AMBIENT_BADGE_SAMPLE_LIMIT }', async () => {
    mockedListProposals.mockResolvedValueOnce({ proposals: [] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAmbientPendingProposalsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListProposals).toHaveBeenCalledWith(workspaceId, {
      pendingOnly: true,
      limit: AMBIENT_BADGE_SAMPLE_LIMIT,
    });
  });

  it('passes refetchInterval equal to the exported AMBIENT_BADGE_POLL_INTERVAL_MS constant to the underlying useQuery call', async () => {
    mockedListProposals.mockResolvedValueOnce({ proposals: [] });
    const { Wrapper } = createWrapper();

    renderHook(() => useAmbientPendingProposalsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockedUseQuery).toHaveBeenCalled();
    });

    expect(lastUseQueryOptions()?.refetchInterval).toBe(AMBIENT_BADGE_POLL_INTERVAL_MS);
  });

  it('passes refetchIntervalInBackground: false to the underlying useQuery call', async () => {
    mockedListProposals.mockResolvedValueOnce({ proposals: [] });
    const { Wrapper } = createWrapper();

    renderHook(() => useAmbientPendingProposalsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockedUseQuery).toHaveBeenCalled();
    });

    expect(lastUseQueryOptions()?.refetchIntervalInBackground).toBe(false);
  });

  it('resolves with hasMore: false and count: 0 when listProposals returns no proposals', async () => {
    mockedListProposals.mockResolvedValueOnce({ proposals: [] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAmbientPendingProposalsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ count: 0, hasMore: false });
  });

  it('resolves with hasMore: true when listProposals returns a nextCursor', async () => {
    mockedListProposals.mockResolvedValueOnce({
      proposals: [makeProposalFixture()],
      nextCursor: 'cursor-2',
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAmbientPendingProposalsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.hasMore).toBe(true);
  });

  it('resolves with hasMore: false when listProposals returns no nextCursor', async () => {
    mockedListProposals.mockResolvedValueOnce({ proposals: [makeProposalFixture()] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAmbientPendingProposalsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.hasMore).toBe(false);
  });

  /**
   * Doğruluk-kritik (accuracy-critical) edge case, spec's explicit Kabul
   * Kriterleri: a proposal with `decidedAt: null` but `actions: []`
   * (a fully `'act_and_notify'` batch that never needed a human decision,
   * ADR-0043 Bağlam #4/Karar e) must NOT be counted -- only proposals with
   * `decidedAt: null` AND `actions.length > 0` count.
   */
  it('excludes a decidedAt:null proposal whose actions array is empty from the count (fully act_and_notify batch, ADR-0043 Karar e)', async () => {
    mockedListProposals.mockResolvedValueOnce({
      proposals: [
        makeProposalFixture({ id: 'proposal-1', decidedAt: null, actions: [] }),
        makeProposalFixture({ id: 'proposal-2', decidedAt: null }),
        makeProposalFixture({ id: 'proposal-3', decidedAt: null }),
      ],
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAmbientPendingProposalsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // 3 proposals returned, only 2 have actual pending actions -- count must
    // be exactly 2, NOT 3.
    expect(result.current.data?.count).toBe(2);
  });
});
