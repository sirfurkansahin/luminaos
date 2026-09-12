import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useExplainDeviationMutation } from './useExplainDeviationMutation.js';
import { explainDeviation } from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';

/**
 * F3-T11 PR3 (sapma açıklama kartı, frontend yarısı, ADR-0045 Karar e/g,
 * spec Kapsam madde 7 + Kabul Kriterleri) -- TDD red step. Contract under
 * test (NEITHER `apiClient.ts`'s `explainDeviation` export NOR
 * `apps/web/src/hooks/useExplainDeviationMutation.ts` exist yet --
 * implementer must build both), mirroring `useCaptureBaselineMutation.ts`/
 * `.test.ts`'s exact structure (F3-T10 PR3, merged), PLUS -- UNLIKE
 * `useCaptureBaselineMutation` -- an `onSuccess` cache invalidation of the
 * single-object query, since `explainDeviation`'s result changes the
 * baseline artifact's OWN `fieldValues` (`explanationSummary`/
 * `explanationCauses`/`explanationGeneratedAt`), which `useObjectQuery`
 * (`../hooks/useObjectsQuery.ts`) caches under
 * `['object', workspaceId, objectId]`:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export function explainDeviation(
 *     workspaceId: string,
 *     baselineObjectId: string,
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // POST /workspaces/:workspaceId/artifacts/baselines/:baselineObjectId/explain
 *       // NO request body (ADR-0045 Karar e).
 *
 *   // apps/web/src/hooks/useExplainDeviationMutation.ts
 *   export function useExplainDeviationMutation(
 *     workspaceId: string,
 *     artifactObjectId: string,
 *   ): UseMutationResult<{ object: ObjectWithFieldValues }, Error, void>;
 *       // mutationFn delegates to
 *       // explainDeviation(workspaceId, artifactObjectId) -- takes NO
 *       // mutation variables (mutate() is called with no arguments, per
 *       // ADR-0045 Karar g's `onClick={() => explainMutation.mutate()}`).
 *       // onSuccess: invalidates the cached ['object', workspaceId,
 *       // artifactObjectId] query (useObjectQuery's own key shape,
 *       // `useObjectsQuery.ts` line 42) so BaselineViewer's re-fetch picks
 *       // up the freshly-persisted explanation fields -- mirrors
 *       // `ArtifactGenerationForm`'s "invalidate the relevant GET after a
 *       // successful mutation" pattern (ADR-0045 Karar g's own rationale).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) -- its own contract
 * for `explainDeviation` is pinned only by
 * `apiClient.explainDeviation.test.ts`, per apiClient.ts's existing
 * convention of being exercised only through its consumers' tests here.
 */

vi.mock('../lib/apiClient.js', () => ({
  explainDeviation: vi.fn(),
}));

const mockedExplainDeviation = vi.mocked(explainDeviation);

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

function makeBaselineObjectFixture(
  overrides: Partial<ObjectWithFieldValues> = {},
): ObjectWithFieldValues {
  return {
    id: 'baseline-1',
    workspaceId: 'ws-1',
    type: 'artifact',
    title: 'Aktif Görev Sayısı',
    createdBy: 'user-1',
    createdAt: new Date('2026-09-12T00:00:00.000Z'),
    updatedAt: new Date('2026-09-12T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {
      artifactType: 'baseline',
      querySpec: JSON.stringify({ objectType: 'task', filters: [] }),
      aggregateFn: 'count',
      capturedValue: 10,
      explanationSummary: 'Bu ay tamamlanan görev sayısı belirgin şekilde arttı.',
      explanationCauses: JSON.stringify(['Ekip büyüdü', 'Süreç iyileştirildi']),
      explanationGeneratedAt: '2026-09-12T00:00:00.000Z',
    },
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useExplainDeviationMutation', () => {
  const workspaceId = 'ws-1';
  const artifactObjectId = 'baseline-1';

  it('calls apiClient.explainDeviation with exactly (workspaceId, artifactObjectId) and no other arguments on mutate()', async () => {
    mockedExplainDeviation.mockResolvedValueOnce({ object: makeBaselineObjectFixture() });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useExplainDeviationMutation(workspaceId, artifactObjectId),
      {
        wrapper: Wrapper,
      },
    );

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedExplainDeviation).toHaveBeenCalledTimes(1);
    expect(mockedExplainDeviation).toHaveBeenCalledWith(workspaceId, artifactObjectId);
  });

  it('resolves with the exact { object } shape returned by apiClient.explainDeviation', async () => {
    const explainResult = { object: makeBaselineObjectFixture() };
    mockedExplainDeviation.mockResolvedValueOnce(explainResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useExplainDeviationMutation(workspaceId, artifactObjectId),
      {
        wrapper: Wrapper,
      },
    );

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(explainResult);
  });

  it('transitions to isError with the thrown error when apiClient.explainDeviation rejects (e.g. server ValidationError for an uncomputable current value)', async () => {
    const error = new Error('Current aggregate value could not be computed for this baseline.');
    mockedExplainDeviation.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useExplainDeviationMutation(workspaceId, artifactObjectId),
      {
        wrapper: Wrapper,
      },
    );

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });

  it('exposes an isPending state while the explainDeviation promise has not yet resolved', async () => {
    let resolvePromise: (value: { object: ObjectWithFieldValues }) => void = () => {
      throw new Error('resolvePromise called before assignment');
    };
    mockedExplainDeviation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useExplainDeviationMutation(workspaceId, artifactObjectId),
      {
        wrapper: Wrapper,
      },
    );

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    act(() => {
      resolvePromise({ object: makeBaselineObjectFixture() });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.isPending).toBe(false);
  });

  it('invalidates the cached ["object", workspaceId, artifactObjectId] query once the mutation succeeds (unlike useCaptureBaselineMutation, which has no such cache to invalidate)', async () => {
    mockedExplainDeviation.mockResolvedValueOnce({ object: makeBaselineObjectFixture() });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () => useExplainDeviationMutation(workspaceId, artifactObjectId),
      {
        wrapper: Wrapper,
      },
    );

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('object');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
    expect(filters?.queryKey?.[2]).toBe(artifactObjectId);
  });

  it('does not invalidate any query before the mutation has resolved', () => {
    mockedExplainDeviation.mockImplementationOnce(() => new Promise(() => {}));
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () => useExplainDeviationMutation(workspaceId, artifactObjectId),
      {
        wrapper: Wrapper,
      },
    );

    act(() => {
      result.current.mutate();
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
