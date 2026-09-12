import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AggregateFn } from '@luminaos/core-objects';
import type { QuerySpec } from '@luminaos/shared';

import { useCaptureBaselineMutation } from './useCaptureBaselineMutation.js';
import { captureBaseline } from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';

/**
 * F3-T10 PR3 (evrensel baseline/sapma motoru, frontend yarısı, ADR-0044
 * Karar d/h, spec Kabul Kriterleri) -- TDD red step. Contract under test
 * (NEITHER `apiClient.ts`'s `captureBaseline` export NOR
 * `apps/web/src/hooks/useCaptureBaselineMutation.ts` exist yet -- implementer
 * must build both), mirroring `useGenerateWidgetMutation.ts`/`.test.ts`'s
 * exact structure (F3-T8 PR3, merged) -- MINUS any query-invalidation, for
 * the same reason: no "list of baselines" query exists for v0:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export function captureBaseline(
 *     workspaceId: string,
 *     input: { title: string; querySpec: QuerySpec; aggregateFn: AggregateFn; targetFieldKey?: string },
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // POST /workspaces/:workspaceId/artifacts/baselines
 *       // (apps/server/src/artifacts/dto/capture-baseline.schema.ts, PR2,
 *       // merged: {title: string(1-200), querySpec: QuerySpec,
 *       // aggregateFn: 7-value-enum, targetFieldKey?: string(1-200)}, .strict())
 *
 *   // apps/web/src/hooks/useCaptureBaselineMutation.ts
 *   export function useCaptureBaselineMutation(workspaceId: string):
 *     UseMutationResult<
 *       { object: ObjectWithFieldValues }, Error,
 *       { title: string; querySpec: QuerySpec; aggregateFn: AggregateFn; targetFieldKey?: string }
 *     >;
 *       // mutationFn delegates to captureBaseline(workspaceId, variables).
 *       // NO onSuccess invalidation.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) -- its own contract
 * for `captureBaseline` is pinned only by this file, per apiClient.ts's
 * existing convention of being exercised only through its consumers' tests.
 */

vi.mock('../lib/apiClient.js', () => ({
  captureBaseline: vi.fn(),
}));

const mockedCaptureBaseline = vi.mocked(captureBaseline);

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
    },
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCaptureBaselineMutation', () => {
  const workspaceId = 'ws-1';
  const variables: {
    title: string;
    querySpec: QuerySpec;
    aggregateFn: AggregateFn;
    targetFieldKey?: string;
  } = {
    title: 'Aktif Görev Sayısı',
    querySpec: { objectType: 'task', filters: [] },
    aggregateFn: 'count',
  };

  it('calls apiClient.captureBaseline with the workspace id and the exact {title, querySpec, aggregateFn, targetFieldKey?} variables on mutate', async () => {
    mockedCaptureBaseline.mockResolvedValueOnce({ object: makeBaselineObjectFixture() });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCaptureBaselineMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCaptureBaseline).toHaveBeenCalledTimes(1);
    expect(mockedCaptureBaseline).toHaveBeenCalledWith(workspaceId, variables);
  });

  it('forwards an optional targetFieldKey through to apiClient.captureBaseline unchanged', async () => {
    mockedCaptureBaseline.mockResolvedValueOnce({ object: makeBaselineObjectFixture() });
    const { Wrapper } = createWrapper();
    const variablesWithTargetField = {
      title: 'Toplam Süre',
      querySpec: { objectType: 'task', filters: [] } satisfies QuerySpec,
      aggregateFn: 'sum' as AggregateFn,
      targetFieldKey: 'estimatedHours',
    };

    const { result } = renderHook(() => useCaptureBaselineMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variablesWithTargetField);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCaptureBaseline).toHaveBeenCalledWith(workspaceId, variablesWithTargetField);
  });

  it('resolves with the exact { object } shape returned by apiClient.captureBaseline', async () => {
    const captureResult = { object: makeBaselineObjectFixture() };
    mockedCaptureBaseline.mockResolvedValueOnce(captureResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCaptureBaselineMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(captureResult);
  });

  it('transitions to isError with the thrown error when apiClient.captureBaseline rejects (e.g. server ValidationError for a grouped querySpec)', async () => {
    const error = new Error('Baselines do not support grouped queries.');
    mockedCaptureBaseline.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCaptureBaselineMutation(workspaceId), {
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

  it('exposes an isPending state while the captureBaseline promise has not yet resolved', async () => {
    let resolvePromise: (value: { object: ObjectWithFieldValues }) => void = () => {
      throw new Error('resolvePromise called before assignment');
    };
    mockedCaptureBaseline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCaptureBaselineMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
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
});
