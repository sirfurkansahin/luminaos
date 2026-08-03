import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedView } from '@luminaos/core-objects';

import {
  useCreateSavedViewMutation,
  useDeleteSavedViewMutation,
  useSavedViewsQuery,
  useUpdateSavedViewMutation,
} from './useSavedViewsQuery.js';
import {
  createSavedView,
  deleteSavedView,
  getSavedViews,
  updateSavedView,
} from '../lib/apiClient.js';

import type { SavedViewCreateInput, SavedViewUpdateInput } from '../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useSavedViewsQuery.ts to satisfy these tests. That's
 * the expected TDD red state.):
 *
 *   export function useSavedViewsQuery(
 *     workspaceId: string,
 *     objectType: string,
 *   ): UseQueryResult<{ savedViews: SavedView[] }>;
 *       // thin wrapper around useQuery — queryFn delegates to
 *       // apiClient.ts's getSavedViews(workspaceId, objectType). queryKey
 *       // MUST be (or start with) ['savedViews', workspaceId, objectType] so
 *       // the mutation hooks below can invalidate it by key prefix
 *       // (['savedViews', workspaceId] alone, without objectType, so that a
 *       // create/update/delete for one objectType also refetches any other
 *       // objectType's cached saved-views list sharing the same workspace —
 *       // there is no cross-objectType leakage risk since the server itself
 *       // still scopes by objectType, this is purely about not needing a
 *       // separate hook per objectType to see fresh data).
 *
 *   export function useCreateSavedViewMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<{ savedView: SavedView }, Error, SavedViewCreateInput>;
 *       // mutationFn delegates to apiClient.ts's
 *       // createSavedView(workspaceId, input). onSuccess invalidates
 *       // ['savedViews', workspaceId, ...] queries — no optimistic update
 *       // (no drag-interaction latency pressure here, per PR2 plan).
 *
 *   export function useUpdateSavedViewMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<
 *     { savedView: SavedView },
 *     Error,
 *     { savedViewId: string; input: SavedViewUpdateInput }
 *   >;
 *       // mutationFn delegates to apiClient.ts's
 *       // updateSavedView(workspaceId, variables.savedViewId, variables.input).
 *       // onSuccess invalidates ['savedViews', workspaceId, ...] queries.
 *
 *   export function useDeleteSavedViewMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<void, Error, string>; // variables = savedViewId
 *       // mutationFn delegates to apiClient.ts's
 *       // deleteSavedView(workspaceId, savedViewId). onSuccess invalidates
 *       // ['savedViews', workspaceId, ...] queries.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * is pinned separately by apps/web/src/lib/apiClient.test.ts, not here.
 */

vi.mock('../lib/apiClient.js', () => ({
  getSavedViews: vi.fn(),
  createSavedView: vi.fn(),
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
}));

const mockedGetSavedViews = vi.mocked(getSavedViews);
const mockedCreateSavedView = vi.mocked(createSavedView);
const mockedUpdateSavedView = vi.mocked(updateSavedView);
const mockedDeleteSavedView = vi.mocked(deleteSavedView);

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

function makeSavedViewFixture(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'sv-1',
    workspaceId: 'ws-1',
    objectType: 'task',
    name: 'Acil görevler',
    icon: 'Star',
    viewType: 'board',
    querySpec: { objectType: 'task', filters: [] },
    ownerId: null,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSavedViewsQuery', () => {
  const workspaceId = 'ws-1';
  const objectType = 'task';

  it('calls apiClient.getSavedViews with the workspace id and object type', async () => {
    const savedView = makeSavedViewFixture();
    mockedGetSavedViews.mockResolvedValueOnce({ savedViews: [savedView] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSavedViewsQuery(workspaceId, objectType), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGetSavedViews).toHaveBeenCalledWith(workspaceId, objectType);
    expect(result.current.data).toEqual({ savedViews: [savedView] });
  });

  it('transitions to isError with the thrown error when apiClient.getSavedViews rejects', async () => {
    const error = new Error('boom');
    mockedGetSavedViews.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSavedViewsQuery(workspaceId, objectType), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useCreateSavedViewMutation', () => {
  const workspaceId = 'ws-1';
  const input: SavedViewCreateInput = {
    name: 'Bu haftaki acil görevler',
    icon: 'Star',
    viewType: 'board',
    objectType: 'task',
    querySpec: { objectType: 'task', filters: [] },
    shared: false,
  };

  it('calls apiClient.createSavedView with the workspace id and input on mutate', async () => {
    mockedCreateSavedView.mockResolvedValueOnce({ savedView: makeSavedViewFixture(input) });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateSavedViewMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCreateSavedView).toHaveBeenCalledWith(workspaceId, input);
  });

  it('invalidates cached ["savedViews", workspaceId, ...] queries once the mutation succeeds', async () => {
    mockedCreateSavedView.mockResolvedValueOnce({ savedView: makeSavedViewFixture(input) });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSavedViewMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('savedViews');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});

describe('useUpdateSavedViewMutation', () => {
  const workspaceId = 'ws-1';
  const savedViewId = 'sv-1';
  const input: SavedViewUpdateInput = { name: 'Yeniden adlandırıldı' };

  it('calls apiClient.updateSavedView with the workspace id, saved view id and input on mutate', async () => {
    mockedUpdateSavedView.mockResolvedValueOnce({
      savedView: makeSavedViewFixture({ id: savedViewId, name: input.name as string }),
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateSavedViewMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ savedViewId, input });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedUpdateSavedView).toHaveBeenCalledWith(workspaceId, savedViewId, input);
  });

  it('invalidates cached ["savedViews", workspaceId, ...] queries once the mutation succeeds', async () => {
    mockedUpdateSavedView.mockResolvedValueOnce({
      savedView: makeSavedViewFixture({ id: savedViewId, name: input.name as string }),
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSavedViewMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ savedViewId, input });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('savedViews');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});

describe('useDeleteSavedViewMutation', () => {
  const workspaceId = 'ws-1';
  const savedViewId = 'sv-1';

  it('calls apiClient.deleteSavedView with the workspace id and saved view id on mutate', async () => {
    mockedDeleteSavedView.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteSavedViewMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(savedViewId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedDeleteSavedView).toHaveBeenCalledWith(workspaceId, savedViewId);
  });

  it('invalidates cached ["savedViews", workspaceId, ...] queries once the mutation succeeds', async () => {
    mockedDeleteSavedView.mockResolvedValueOnce(undefined);
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSavedViewMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(savedViewId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('savedViews');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});
