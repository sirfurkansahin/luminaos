import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useNotificationPreferenceQuery,
  useSetNotificationPreferenceMutation,
} from './useNotificationPreferenceQuery.js';
import { getNotificationPreference, setNotificationPreference } from '../lib/apiClient.js';

/**
 * F3-T13 PR3 (ADR-0047 Karar b/i, spec Kabul Kriterleri) — TDD red step.
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useNotificationPreferenceQuery.ts AND add the following
 * new exports to apps/web/src/lib/apiClient.ts to satisfy these tests; that's
 * the expected TDD red state), mirroring
 * `useAutonomyTierSettingsQuery.ts`/`.test.ts`'s exact query-key/invalidation
 * shape and test structure (own hook file per resource, per this codebase's
 * "personal preference is a categorically distinct concept from a workspace
 * policy setting" precedent already documented in
 * `AutonomyTierPanel.tsx`/ADR-0047 Karar g):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface QuietHoursWindow { startHourUtc: number; endHourUtc: number; }
 *   export interface NotificationPreference {
 *     id: string; workspaceId: string; userId: string;
 *     notificationBudgetPerWindow: number; quietHours: QuietHoursWindow | null;
 *     updatedAt: string;
 *   }
 *   export interface NotificationPreferenceInput {
 *     notificationBudgetPerWindow: number; quietHours: QuietHoursWindow | null;
 *   }
 *   export function getNotificationPreference(
 *     workspaceId: string, userId: string,
 *   ): Promise<{ preference: NotificationPreference | null }>;
 *       // GET /workspaces/:workspaceId/notification-preferences/:userId
 *       // (NotificationPreferencesService.get's self-or-admin RBAC, ADR-0047
 *       // Karar i — 403 surfaces as a rejected promise, same as
 *       // useAutonomyTierSettingsQuery.test.ts's 403 case below)
 *   export function setNotificationPreference(
 *     workspaceId: string, userId: string, input: NotificationPreferenceInput,
 *   ): Promise<{ preference: NotificationPreference }>;
 *       // PUT /workspaces/:workspaceId/notification-preferences/:userId
 *       // (NotificationPreferencesService.set's self-ONLY RBAC, ADR-0047
 *       // Karar i — admin included, 403 surfaces as a rejected promise)
 *
 *   // apps/web/src/hooks/useNotificationPreferenceQuery.ts
 *   export function useNotificationPreferenceQuery(
 *     workspaceId: string, userId: string,
 *   ): UseQueryResult<{ preference: NotificationPreference | null }>;
 *       // queryKey MUST be exactly
 *       // ['notification-preference', workspaceId, userId].
 *   export function useSetNotificationPreferenceMutation(
 *     workspaceId: string, userId: string,
 *   ): UseMutationResult<
 *     { preference: NotificationPreference }, Error, NotificationPreferenceInput
 *   >;
 *       // mutationFn delegates to
 *       // setNotificationPreference(workspaceId, userId, variables).
 *       // onSuccess invalidates
 *       // ['notification-preference', workspaceId, userId] (exact key).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the two new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useAutonomyTierSettingsQuery.test.ts's identical
 * rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  getNotificationPreference: vi.fn(),
  setNotificationPreference: vi.fn(),
}));

const mockedGetNotificationPreference = vi.mocked(getNotificationPreference);
const mockedSetNotificationPreference = vi.mocked(setNotificationPreference);

interface QuietHoursWindow {
  startHourUtc: number;
  endHourUtc: number;
}

interface NotificationPreference {
  id: string;
  workspaceId: string;
  userId: string;
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
  updatedAt: string;
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

function makePreferenceFixture(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: 'pref-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    notificationBudgetPerWindow: 10,
    quietHours: { startHourUtc: 22, endHourUtc: 7 },
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useNotificationPreferenceQuery', () => {
  const workspaceId = 'ws-1';
  const userId = 'user-1';

  it('calls apiClient.getNotificationPreference with the workspace id and user id', async () => {
    const preference = makePreferenceFixture();
    mockedGetNotificationPreference.mockResolvedValueOnce({ preference });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationPreferenceQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGetNotificationPreference).toHaveBeenCalledWith(workspaceId, userId);
    expect(result.current.data).toEqual({ preference });
  });

  it('exposes the exact ["notification-preference", workspaceId, userId] query key', async () => {
    const preference = makePreferenceFixture();
    mockedGetNotificationPreference.mockResolvedValueOnce({ preference });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationPreferenceQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['notification-preference', workspaceId, userId]);
    expect(cached).toEqual({ preference });
  });

  it('resolves with { preference: null } when the caller has no stored preference yet (fail-open, ADR-0047 Karar b)', async () => {
    mockedGetNotificationPreference.mockResolvedValueOnce({ preference: null });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationPreferenceQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ preference: null });
  });

  it('transitions to isError with the thrown error when apiClient.getNotificationPreference rejects (e.g. 403 self-or-admin RBAC)', async () => {
    const error = new Error('Forbidden');
    mockedGetNotificationPreference.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useNotificationPreferenceQuery(workspaceId, userId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useSetNotificationPreferenceMutation', () => {
  const workspaceId = 'ws-1';
  const userId = 'user-1';
  const variables = {
    notificationBudgetPerWindow: 5,
    quietHours: { startHourUtc: 23, endHourUtc: 6 },
  };

  function makeSetResult(): { preference: NotificationPreference } {
    return {
      preference: makePreferenceFixture({
        notificationBudgetPerWindow: variables.notificationBudgetPerWindow,
        quietHours: variables.quietHours,
        updatedAt: '2026-09-02T00:00:00.000Z',
      }),
    };
  }

  it('calls apiClient.setNotificationPreference with the workspace id, user id and input on mutate', async () => {
    mockedSetNotificationPreference.mockResolvedValueOnce(makeSetResult());
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetNotificationPreferenceMutation(workspaceId, userId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedSetNotificationPreference).toHaveBeenCalledWith(workspaceId, userId, variables);
  });

  it('invalidates the exact ["notification-preference", workspaceId, userId] query once the mutation succeeds', async () => {
    mockedSetNotificationPreference.mockResolvedValueOnce(makeSetResult());
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetNotificationPreferenceMutation(workspaceId, userId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['notification-preference', workspaceId, userId],
    });
  });

  it('resolves with the { preference } shape returned by apiClient.setNotificationPreference', async () => {
    const setResult = makeSetResult();
    mockedSetNotificationPreference.mockResolvedValueOnce(setResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetNotificationPreferenceMutation(workspaceId, userId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(setResult);
  });

  it('transitions to isError with the thrown error when apiClient.setNotificationPreference rejects (e.g. 403 self-only RBAC, admin included)', async () => {
    const error = new Error('Forbidden');
    mockedSetNotificationPreference.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetNotificationPreferenceMutation(workspaceId, userId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});
