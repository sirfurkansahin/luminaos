import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGenerateWidgetMutation } from './useGenerateWidgetMutation.js';
import { generateWidget } from '../lib/apiClient.js';

import type { ObjectWithFieldValues, ThemePresetName } from '../lib/apiClient.js';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar a/c/i, spec Kabul
 * Kriterleri) -- TDD red step. Contract under test (NEITHER
 * apps/web/src/lib/apiClient.ts's `generateWidget` export NOR
 * apps/web/src/hooks/useGenerateWidgetMutation.ts exist yet -- implementer
 * must build both), mirroring useGenerateArtifactMutation.ts/.test.ts's
 * exact test structure (F3-T7 PR3, merged) -- MINUS any query-invalidation
 * test, for the identical reason: no "list of widgets" query exists for v0:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export function generateWidget(
 *     workspaceId: string,
 *     input: { prompt: string; objectType: string; themePreset: ThemePresetName },
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // POST /workspaces/:workspaceId/artifacts/widgets
 *       // (apps/server/src/artifacts/dto/generate-widget.schema.ts, PR2,
 *       // merged: {prompt: string(1-4000), objectType: string(1-100),
 *       // themePreset: enum('kurumsal'|'canli'|'minimal')}, .strict())
 *
 *   // apps/web/src/hooks/useGenerateWidgetMutation.ts
 *   export function useGenerateWidgetMutation(workspaceId: string):
 *     UseMutationResult<
 *       { object: ObjectWithFieldValues }, Error,
 *       { prompt: string; objectType: string; themePreset: ThemePresetName }
 *     >;
 *       // mutationFn delegates to generateWidget(workspaceId, variables).
 *       // NO onSuccess invalidation.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) -- its own contract
 * for `generateWidget` is pinned only by this file, per apiClient.ts's
 * existing convention of being exercised only through its consumers' tests.
 */

vi.mock('../lib/apiClient.js', () => ({
  generateWidget: vi.fn(),
}));

const mockedGenerateWidget = vi.mocked(generateWidget);

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

function makeWidgetObjectFixture(
  overrides: Partial<ObjectWithFieldValues> = {},
): ObjectWithFieldValues {
  return {
    id: 'widget-1',
    workspaceId: 'ws-1',
    type: 'artifact',
    title: 'Gecikmiş Görevler',
    createdBy: 'user-1',
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {
      htmlContent: '<!DOCTYPE html><html><body><table></table></body></html>',
      themePreset: 'kurumsal',
      generationPrompt: 'gecikmiş görevleri sorumluya göre göster',
      artifactType: 'dashboard',
      querySpec: JSON.stringify({ objectType: 'task', filters: [] }),
    },
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useGenerateWidgetMutation', () => {
  const workspaceId = 'ws-1';
  const variables = {
    prompt: 'gecikmiş görevleri sorumluya göre göster',
    objectType: 'task',
    themePreset: 'kurumsal' as ThemePresetName,
  };

  it('calls apiClient.generateWidget with the workspace id and the exact {prompt, objectType, themePreset} variables on mutate', async () => {
    mockedGenerateWidget.mockResolvedValueOnce({ object: makeWidgetObjectFixture() });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateWidgetMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGenerateWidget).toHaveBeenCalledTimes(1);
    expect(mockedGenerateWidget).toHaveBeenCalledWith(workspaceId, variables);
  });

  it('resolves with the exact { object } shape returned by apiClient.generateWidget', async () => {
    const generateResult = { object: makeWidgetObjectFixture() };
    mockedGenerateWidget.mockResolvedValueOnce(generateResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateWidgetMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(generateResult);
  });

  it('transitions to isError with the thrown error when apiClient.generateWidget rejects (e.g. server ValidationError from compileWidgetQuery exhaustion)', async () => {
    const error = new Error('Widget query compilation failed.');
    mockedGenerateWidget.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateWidgetMutation(workspaceId), {
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

  it('exposes an isPending state while the generateWidget promise has not yet resolved', async () => {
    let resolvePromise: (value: { object: ObjectWithFieldValues }) => void = () => {
      throw new Error('resolvePromise called before assignment');
    };
    mockedGenerateWidget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateWidgetMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    act(() => {
      resolvePromise({ object: makeWidgetObjectFixture() });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.isPending).toBe(false);
  });
});
