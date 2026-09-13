import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNotificationUsageSummaryQuery } from './useNotificationUsageSummaryQuery.js';
import { getNotificationUsageSummary } from '../lib/apiClient.js';

/**
 * F3-T13 PR3 (ADR-0047 Karar f/g, spec Kabul Kriterleri) — TDD red step.
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useNotificationUsageSummaryQuery.ts AND add the
 * following new exports to apps/web/src/lib/apiClient.ts to satisfy these
 * tests; that's the expected TDD red state), mirroring
 * `useAgentActionRecordsQuery.test.ts`'s "read-only, no mutation counterpart"
 * single-query shape exactly (this summary is CANLI/derived, ADR-0047 Karar
 * f — there is no write endpoint for it, so no mutation hook to mirror):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface NotificationUsageSummary {
 *     deliveredCountInWindow: number;
 *     overloaded: boolean;
 *     topActionType: { actionType: string; count: number } | null;
 *   }
 *   export function getNotificationUsageSummary(
 *     workspaceId: string, userId: string,
 *   ): Promise<{ summary: NotificationUsageSummary }>;
 *       // GET /workspaces/:workspaceId/notification-preferences/:userId/usage-summary
 *       // (AgentNotificationGovernorService.getUsageSummary's self-or-admin
 *       // RBAC, ADR-0047 Somut Şekiller "RBAC özeti" — 403 surfaces as a
 *       // rejected promise)
 *
 *   // apps/web/src/hooks/useNotificationUsageSummaryQuery.ts
 *   export function useNotificationUsageSummaryQuery(
 *     workspaceId: string, userId: string,
 *   ): UseQueryResult<{ summary: NotificationUsageSummary }>;
 *       // queryKey MUST be exactly
 *       // ['notification-usage-summary', workspaceId, userId].
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the new function above is pinned only by this file, per apiClient.ts's
 * existing convention of being exercised only through its consumers' tests
 * (see useAgentActionRecordsQuery.test.ts's identical rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  getNotificationUsageSummary: vi.fn(),
}));

const mockedGetNotificationUsageSummary = vi.mocked(getNotificationUsageSummary);

interface NotificationUsageSummary {
  deliveredCountInWindow: number;
  overloaded: boolean;
  topActionType: { actionType: string; count: number } | null;
}

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

function makeSummaryFixture(
  overrides: Partial<NotificationUsageSummary> = {},
): NotificationUsageSummary {
  return {
    deliveredCountInWindow: 3,
    overloaded: false,
    topActionType: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useNotificationUsageSummaryQuery', () => {
  const workspaceId = 'ws-1';
  const userId = 'user-1';

  it('calls apiClient.getNotificationUsageSummary with the workspace id and user id', async () => {
    const summary = makeSummaryFixture();
    mockedGetNotificationUsageSummary.mockResolvedValueOnce({ summary });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationUsageSummaryQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGetNotificationUsageSummary).toHaveBeenCalledWith(workspaceId, userId);
    expect(result.current.data).toEqual({ summary });
  });

  it('exposes the exact ["notification-usage-summary", workspaceId, userId] query key', async () => {
    const summary = makeSummaryFixture();
    mockedGetNotificationUsageSummary.mockResolvedValueOnce({ summary });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationUsageSummaryQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['notification-usage-summary', workspaceId, userId]);
    expect(cached).toEqual({ summary });
  });

  it('resolves with overloaded=true and a populated topActionType when the budget is exhausted (ADR-0047 Karar f)', async () => {
    const summary = makeSummaryFixture({
      deliveredCountInWindow: 12,
      overloaded: true,
      topActionType: { actionType: 'createTask', count: 9 },
    });
    mockedGetNotificationUsageSummary.mockResolvedValueOnce({ summary });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationUsageSummaryQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ summary });
  });

  it('transitions to isError with the thrown error when apiClient.getNotificationUsageSummary rejects (e.g. 403 self-or-admin RBAC)', async () => {
    const error = new Error('Forbidden');
    mockedGetNotificationUsageSummary.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationUsageSummaryQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});
