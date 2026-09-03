import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useDecideTriggerSuggestionMutation,
  useRunTriggerSuggestionsAnalysisMutation,
  useTriggerSuggestionsQuery,
} from './useTriggerSuggestionsQuery.js';
import {
  decideTriggerSuggestion,
  listTriggerSuggestions,
  runTriggerSuggestionsAnalysis,
} from '../lib/apiClient.js';

import type { TriggerTemplateSuggestionSummary } from '../lib/apiClient.js';

/**
 * F2-T17 PR3 (ADR-0034, spec Kabul Kriterleri) — TDD red step. Contract under
 * test (not yet implemented — implementer must build
 * apps/web/src/hooks/useTriggerSuggestionsQuery.ts AND add the following new
 * exports to apps/web/src/lib/apiClient.ts to satisfy these tests; that's the
 * expected TDD red state), mirroring useProposalsQuery.ts/.test.ts's exact
 * query-key/invalidation shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export type TriggerSpecSummary =
 *     | { kind: 'scheduled'; intervalMinutes: number; actionTemplate: { title: string } }
 *     | { kind: 'condition'; objectType: string; fieldKey: string; pattern: string; flags: string; actionTemplate: { title: string } };
 *   export interface TriggerTemplateSuggestionSummary {
 *     id: string; workspaceId: string; name: string; kind: 'scheduled' | 'condition';
 *     spec: TriggerSpecSummary; rationale: string; status: 'pending' | 'approved' | 'rejected';
 *     createdTriggerId: string | null; createdAt: string; decidedAt: string | null;
 *   }
 *   export function listTriggerSuggestions(
 *     workspaceId: string,
 *   ): Promise<{ suggestions: TriggerTemplateSuggestionSummary[] }>;
 *   export function runTriggerSuggestionsAnalysis(
 *     workspaceId: string,
 *   ): Promise<{ suggestions: TriggerTemplateSuggestionSummary[] }>;
 *   export function decideTriggerSuggestion(
 *     workspaceId: string, suggestionId: string, decision: 'approve' | 'reject',
 *   ): Promise<{ suggestion: TriggerTemplateSuggestionSummary }>;
 *
 *   // apps/web/src/hooks/useTriggerSuggestionsQuery.ts
 *   export function useTriggerSuggestionsQuery(
 *     workspaceId: string,
 *   ): UseQueryResult<{ suggestions: TriggerTemplateSuggestionSummary[] }>;
 *       // queryKey MUST be exactly ['trigger-suggestions', workspaceId] (no
 *       // filter argument exists for this query, unlike useProposalsQuery).
 *   export function useRunTriggerSuggestionsAnalysisMutation(workspaceId: string):
 *     UseMutationResult<{ suggestions: TriggerTemplateSuggestionSummary[] }, Error, void>;
 *       // mutationFn delegates to runTriggerSuggestionsAnalysis(workspaceId),
 *       // takes NO variables (mutate() called with zero arguments).
 *       // onSuccess invalidates ['trigger-suggestions', workspaceId] (exact key).
 *   export function useDecideTriggerSuggestionMutation(workspaceId: string):
 *     UseMutationResult<
 *       { suggestion: TriggerTemplateSuggestionSummary }, Error,
 *       { suggestionId: string; decision: 'approve' | 'reject' }
 *     >;
 *       // mutationFn delegates to
 *       // decideTriggerSuggestion(workspaceId, variables.suggestionId, variables.decision).
 *       // onSuccess invalidates ['trigger-suggestions', workspaceId] (exact key).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the three new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useProposalsQuery.test.ts's identical rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  listTriggerSuggestions: vi.fn(),
  runTriggerSuggestionsAnalysis: vi.fn(),
  decideTriggerSuggestion: vi.fn(),
}));

const mockedListTriggerSuggestions = vi.mocked(listTriggerSuggestions);
const mockedRunTriggerSuggestionsAnalysis = vi.mocked(runTriggerSuggestionsAnalysis);
const mockedDecideTriggerSuggestion = vi.mocked(decideTriggerSuggestion);

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

function makeSuggestionFixture(
  overrides: Partial<TriggerTemplateSuggestionSummary> = {},
): TriggerTemplateSuggestionSummary {
  return {
    id: 'suggestion-1',
    workspaceId: 'ws-1',
    name: 'Haftalık rapor hatırlatıcısı',
    kind: 'scheduled',
    spec: {
      kind: 'scheduled',
      intervalMinutes: 10080,
      actionTemplate: { title: 'Haftalık rapor gönder' },
    },
    rationale: 'Bu görev her hafta tekrarlanıyor',
    status: 'pending',
    createdTriggerId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTriggerSuggestionsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listTriggerSuggestions with the workspace id', async () => {
    const suggestion = makeSuggestionFixture();
    mockedListTriggerSuggestions.mockResolvedValueOnce({ suggestions: [suggestion] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useTriggerSuggestionsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListTriggerSuggestions).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ suggestions: [suggestion] });
  });

  it('exposes the exact ["trigger-suggestions", workspaceId] query key', async () => {
    const suggestion = makeSuggestionFixture();
    mockedListTriggerSuggestions.mockResolvedValueOnce({ suggestions: [suggestion] });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useTriggerSuggestionsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['trigger-suggestions', workspaceId]);
    expect(cached).toEqual({ suggestions: [suggestion] });
  });

  it('transitions to isError with the thrown error when apiClient.listTriggerSuggestions rejects', async () => {
    const error = new Error('boom');
    mockedListTriggerSuggestions.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useTriggerSuggestionsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useRunTriggerSuggestionsAnalysisMutation', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.runTriggerSuggestionsAnalysis with the workspace id when mutate() is called with no arguments', async () => {
    const suggestion = makeSuggestionFixture();
    mockedRunTriggerSuggestionsAnalysis.mockResolvedValueOnce({ suggestions: [suggestion] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useRunTriggerSuggestionsAnalysisMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedRunTriggerSuggestionsAnalysis).toHaveBeenCalledWith(workspaceId);
  });

  it('invalidates the exact ["trigger-suggestions", workspaceId] query once the mutation succeeds', async () => {
    const suggestion = makeSuggestionFixture();
    mockedRunTriggerSuggestionsAnalysis.mockResolvedValueOnce({ suggestions: [suggestion] });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRunTriggerSuggestionsAnalysisMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['trigger-suggestions', workspaceId],
    });
  });

  it('transitions to isError with the thrown error when apiClient.runTriggerSuggestionsAnalysis rejects (e.g. cooldown 409)', async () => {
    const error = new Error('cooldown active');
    mockedRunTriggerSuggestionsAnalysis.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useRunTriggerSuggestionsAnalysisMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useDecideTriggerSuggestionMutation', () => {
  const workspaceId = 'ws-1';
  const variables = { suggestionId: 'suggestion-1', decision: 'approve' as const };

  function makeDecideResult(): { suggestion: TriggerTemplateSuggestionSummary } {
    return {
      suggestion: makeSuggestionFixture({
        status: 'approved',
        decidedAt: '2026-08-02T00:00:00.000Z',
      }),
    };
  }

  it('calls apiClient.decideTriggerSuggestion with the workspace id, suggestionId and decision on mutate', async () => {
    mockedDecideTriggerSuggestion.mockResolvedValueOnce(makeDecideResult());
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDecideTriggerSuggestionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedDecideTriggerSuggestion).toHaveBeenCalledWith(
      workspaceId,
      variables.suggestionId,
      variables.decision,
    );
  });

  it('invalidates the exact ["trigger-suggestions", workspaceId] query once the mutation succeeds', async () => {
    mockedDecideTriggerSuggestion.mockResolvedValueOnce(makeDecideResult());
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDecideTriggerSuggestionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['trigger-suggestions', workspaceId],
    });
  });

  it('resolves with the { suggestion } shape returned by apiClient.decideTriggerSuggestion', async () => {
    const decideResult = makeDecideResult();
    mockedDecideTriggerSuggestion.mockResolvedValueOnce(decideResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDecideTriggerSuggestionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(decideResult);
  });
});
