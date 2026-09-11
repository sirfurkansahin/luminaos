import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useAutonomyTierSettingsQuery,
  useSetAutonomyTierMutation,
} from './useAutonomyTierSettingsQuery.js';
import { listAutonomyTierSettings, setAutonomyTier } from '../lib/apiClient.js';

import type { AutonomyTier, TaskAutonomySetting } from '../lib/apiClient.js';

/**
 * F3-T5 PR3 (otonomi kadranı, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useAutonomyTierSettingsQuery.ts AND add the following
 * new exports to apps/web/src/lib/apiClient.ts to satisfy these tests; that's
 * the expected TDD red state), mirroring useTriggerSuggestionsQuery.ts/
 * .test.ts's exact query-key/invalidation shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export type AutonomyTier = 'propose' | 'approve_and_act' | 'act_and_notify';
 *   export interface TaskAutonomySetting {
 *     id: string; workspaceId: string; actionType: string; tier: AutonomyTier;
 *     updatedBy: { type: 'user' | 'agent' | 'system'; id: string }; updatedAt: string;
 *   }
 *   export function listAutonomyTierSettings(
 *     workspaceId: string,
 *   ): Promise<{ settings: TaskAutonomySetting[] }>;
 *   export function setAutonomyTier(
 *     workspaceId: string, actionType: string, tier: AutonomyTier,
 *   ): Promise<{ setting: TaskAutonomySetting }>;
 *
 *   // apps/web/src/hooks/useAutonomyTierSettingsQuery.ts
 *   export function useAutonomyTierSettingsQuery(
 *     workspaceId: string,
 *   ): UseQueryResult<{ settings: TaskAutonomySetting[] }>;
 *       // queryKey MUST be exactly ['autonomy-tier-settings', workspaceId].
 *   export function useSetAutonomyTierMutation(workspaceId: string):
 *     UseMutationResult<
 *       { setting: TaskAutonomySetting }, Error,
 *       { actionType: string; tier: AutonomyTier }
 *     >;
 *       // mutationFn delegates to
 *       // setAutonomyTier(workspaceId, variables.actionType, variables.tier).
 *       // onSuccess invalidates ['autonomy-tier-settings', workspaceId] (exact key).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the two new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useTriggerSuggestionsQuery.test.ts's identical
 * rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  listAutonomyTierSettings: vi.fn(),
  setAutonomyTier: vi.fn(),
}));

const mockedListAutonomyTierSettings = vi.mocked(listAutonomyTierSettings);
const mockedSetAutonomyTier = vi.mocked(setAutonomyTier);

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

function makeSettingFixture(overrides: Partial<TaskAutonomySetting> = {}): TaskAutonomySetting {
  return {
    id: 'setting-1',
    workspaceId: 'ws-1',
    actionType: 'createTask',
    tier: 'approve_and_act',
    updatedBy: { type: 'user', id: 'user-1' },
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useAutonomyTierSettingsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listAutonomyTierSettings with the workspace id', async () => {
    const setting = makeSettingFixture();
    mockedListAutonomyTierSettings.mockResolvedValueOnce({ settings: [setting] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAutonomyTierSettingsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListAutonomyTierSettings).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ settings: [setting] });
  });

  it('exposes the exact ["autonomy-tier-settings", workspaceId] query key', async () => {
    const setting = makeSettingFixture();
    mockedListAutonomyTierSettings.mockResolvedValueOnce({ settings: [setting] });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useAutonomyTierSettingsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['autonomy-tier-settings', workspaceId]);
    expect(cached).toEqual({ settings: [setting] });
  });

  it('transitions to isError with the thrown error when apiClient.listAutonomyTierSettings rejects', async () => {
    const error = new Error('boom');
    mockedListAutonomyTierSettings.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAutonomyTierSettingsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useSetAutonomyTierMutation', () => {
  const workspaceId = 'ws-1';
  const variables = { actionType: 'createTask', tier: 'act_and_notify' as AutonomyTier };

  function makeSetResult(): { setting: TaskAutonomySetting } {
    return {
      setting: makeSettingFixture({
        actionType: variables.actionType,
        tier: variables.tier,
        updatedAt: '2026-08-02T00:00:00.000Z',
      }),
    };
  }

  it('calls apiClient.setAutonomyTier with the workspace id, actionType and tier on mutate', async () => {
    mockedSetAutonomyTier.mockResolvedValueOnce(makeSetResult());
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetAutonomyTierMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedSetAutonomyTier).toHaveBeenCalledWith(
      workspaceId,
      variables.actionType,
      variables.tier,
    );
  });

  it('invalidates the exact ["autonomy-tier-settings", workspaceId] query once the mutation succeeds', async () => {
    mockedSetAutonomyTier.mockResolvedValueOnce(makeSetResult());
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetAutonomyTierMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['autonomy-tier-settings', workspaceId],
    });
  });

  it('resolves with the { setting } shape returned by apiClient.setAutonomyTier', async () => {
    const setResult = makeSetResult();
    mockedSetAutonomyTier.mockResolvedValueOnce(setResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetAutonomyTierMutation(workspaceId), {
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

  it('transitions to isError with the thrown error when apiClient.setAutonomyTier rejects (e.g. 403 governance floor)', async () => {
    const error = new Error('governance floor violation');
    mockedSetAutonomyTier.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSetAutonomyTierMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ actionType: 'reconfigureAgentPermissions', tier: 'approve_and_act' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});
