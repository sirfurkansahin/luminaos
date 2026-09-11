import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGenerateArtifactMutation } from './useGenerateArtifactMutation.js';
import { generateArtifact } from '../lib/apiClient.js';

import type { ArtifactType, ObjectWithFieldValues, ThemePresetName } from '../lib/apiClient.js';

/**
 * F3-T7 PR3 (artifact boru hattı, ADR-0041 Karar d/h, spec Kabul Kriterleri)
 * — TDD red step. Contract under test (not yet implemented — implementer
 * must build apps/web/src/hooks/useGenerateArtifactMutation.ts AND add the
 * following new exports to apps/web/src/lib/apiClient.ts to satisfy these
 * tests; that's the expected TDD red state), mirroring
 * useAutonomyTierSettingsQuery.ts/.test.ts's `useSetAutonomyTierMutation`
 * exact test structure -- MINUS any query-invalidation test, since this
 * mutation has no "list of artifacts" query to invalidate for v0 (the
 * generation form's own local state/mutation.data holds the just-created
 * object for immediate display):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export type ArtifactType = 'presentation' | 'dashboard' | 'page' | 'report';
 *   export type ThemePresetName = 'kurumsal' | 'canli' | 'minimal';
 *   export function generateArtifact(
 *     workspaceId: string,
 *     input: { prompt: string; artifactType: ArtifactType; themePreset: ThemePresetName },
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // POST /workspaces/:workspaceId/artifacts
 *
 *   // apps/web/src/hooks/useGenerateArtifactMutation.ts
 *   export function useGenerateArtifactMutation(workspaceId: string):
 *     UseMutationResult<
 *       { object: ObjectWithFieldValues }, Error,
 *       { prompt: string; artifactType: ArtifactType; themePreset: ThemePresetName }
 *     >;
 *       // mutationFn delegates to
 *       // generateArtifact(workspaceId, variables). NO onSuccess
 *       // invalidation (no artifact-list query exists for v0).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for `generateArtifact` is pinned only by this file, per apiClient.ts's
 * existing convention of being exercised only through its consumers' tests
 * (see useAutonomyTierSettingsQuery.test.ts's identical rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  generateArtifact: vi.fn(),
}));

const mockedGenerateArtifact = vi.mocked(generateArtifact);

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

function makeObjectFixture(overrides: Partial<ObjectWithFieldValues> = {}): ObjectWithFieldValues {
  return {
    id: 'artifact-1',
    workspaceId: 'ws-1',
    type: 'artifact',
    title: 'Q3 Satış Sunumu',
    createdBy: 'user-1',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {
      htmlContent: '<!DOCTYPE html><html><body><h1>Q3</h1></body></html>',
      themePreset: 'kurumsal',
      generationPrompt: 'Q3 satış rakamlarını özetleyen bir sunum hazırla',
      artifactType: 'presentation',
    },
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useGenerateArtifactMutation', () => {
  const workspaceId = 'ws-1';
  const variables = {
    prompt: 'Q3 satış rakamlarını özetleyen bir sunum hazırla',
    artifactType: 'presentation' as ArtifactType,
    themePreset: 'kurumsal' as ThemePresetName,
  };

  it('calls apiClient.generateArtifact with the workspace id and the exact {prompt, artifactType, themePreset} variables on mutate', async () => {
    mockedGenerateArtifact.mockResolvedValueOnce({ object: makeObjectFixture() });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateArtifactMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGenerateArtifact).toHaveBeenCalledTimes(1);
    expect(mockedGenerateArtifact).toHaveBeenCalledWith(workspaceId, variables);
  });

  it('resolves with the exact { object } shape returned by apiClient.generateArtifact', async () => {
    const generateResult = { object: makeObjectFixture() };
    mockedGenerateArtifact.mockResolvedValueOnce(generateResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateArtifactMutation(workspaceId), {
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

  it('transitions to isError with the thrown error when apiClient.generateArtifact rejects (e.g. server ValidationError)', async () => {
    const error = new Error('Generated artifact exceeded the maximum allowed size');
    mockedGenerateArtifact.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateArtifactMutation(workspaceId), {
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

  it('exposes an isPending state while the generateArtifact promise has not yet resolved', async () => {
    let resolvePromise: (value: { object: ObjectWithFieldValues }) => void = () => {
      throw new Error('resolvePromise called before assignment');
    };
    mockedGenerateArtifact.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateArtifactMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    act(() => {
      resolvePromise({ object: makeObjectFixture() });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.isPending).toBe(false);
  });
});
