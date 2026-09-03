import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDecideProposalMutation, useProposalsQuery } from './useProposalsQuery.js';
import { decideProposal, listProposals } from '../lib/apiClient.js';

import type { CommandProposalSummary, DecideActionResult } from '../lib/apiClient.js';

/**
 * F2-T16 PR4 (ADR-0033 §g/§h, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useProposalsQuery.ts AND add the following new exports
 * to apps/web/src/lib/apiClient.ts to satisfy these tests; that's the
 * expected TDD red state), mirroring useMcpGrantsQuery.ts/.test.ts's exact
 * query-key/invalidation-by-prefix shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface ProposedActionSummary {
 *     actionId: string; type: string; intent: string; rationale: string;
 *     resources: string[]; rollbackNote: string; params: Record<string, unknown>;
 *   }
 *   export interface DecideActionResult {
 *     actionId: string; status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
 *     createdCount?: number; totalCount?: number; failedAtStep?: number; error?: string;
 *   }
 *   export interface CommandProposalSummary {
 *     id: string; workspaceId: string; command: string; sourceObjectId: string | null;
 *     actions: ProposedActionSummary[]; decisions: DecideActionResult[] | null;
 *     createdAt: string; decidedAt: string | null;
 *   }
 *   export function listProposals(
 *     workspaceId: string, filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
 *   ): Promise<{ proposals: CommandProposalSummary[]; nextCursor?: string }>;
 *   export function decideProposal(
 *     workspaceId: string, proposalId: string,
 *     decisions: { actionId: string; decision: 'approved' | 'rejected' }[],
 *   ): Promise<{ results: DecideActionResult[] }>;
 *
 *   // apps/web/src/hooks/useProposalsQuery.ts
 *   export function useProposalsQuery(
 *     workspaceId: string, filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
 *   ): UseQueryResult<{ proposals: CommandProposalSummary[]; nextCursor?: string }>;
 *       // queryKey MUST be (or start with) ['proposals', workspaceId] -- filter
 *       // may be appended to the key (e.g. ['proposals', workspaceId, filter]),
 *       // implementer's call, just internally consistent.
 *   export function useDecideProposalMutation(workspaceId: string):
 *     UseMutationResult<
 *       { results: DecideActionResult[] }, Error,
 *       { proposalId: string; decisions: { actionId: string; decision: 'approved' | 'rejected' }[] }
 *     >;
 *       // mutationFn delegates to
 *       // decideProposal(workspaceId, variables.proposalId, variables.decisions).
 *       // onSuccess invalidates BY PREFIX ['proposals', workspaceId] queries
 *       // (so it refetches regardless of what filter-specific key variant is
 *       // cached -- assert the invalidated queryKey STARTS WITH
 *       // ['proposals', workspaceId], not that it equals it exactly).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the two new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useMcpGrantsQuery.test.ts's identical rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  listProposals: vi.fn(),
  decideProposal: vi.fn(),
}));

const mockedListProposals = vi.mocked(listProposals);
const mockedDecideProposal = vi.mocked(decideProposal);

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

function makeProposalFixture(
  overrides: Partial<CommandProposalSummary> = {},
): CommandProposalSummary {
  return {
    id: 'proposal-1',
    workspaceId: 'ws-1',
    command: 'Toplantıdan sonra Ayşe için bir görev oluştur',
    sourceObjectId: 'meeting-1',
    actions: [
      {
        actionId: 'action-1',
        type: 'createTask',
        intent: "Ayşe için 'Rapor gönder' görevi oluştur",
        rationale: 'Toplantıda bahsedildi',
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

describe('useProposalsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listProposals with the workspace id and no filter when omitted', async () => {
    const proposal = makeProposalFixture();
    mockedListProposals.mockResolvedValueOnce({ proposals: [proposal] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useProposalsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListProposals).toHaveBeenCalledWith(workspaceId, undefined);
    expect(result.current.data).toEqual({ proposals: [proposal] });
  });

  it('calls apiClient.listProposals with the workspace id and the given filter', async () => {
    const proposal = makeProposalFixture();
    mockedListProposals.mockResolvedValueOnce({ proposals: [proposal] });
    const { Wrapper } = createWrapper();
    const filter = { pendingOnly: true, limit: 20 };

    const { result } = renderHook(() => useProposalsQuery(workspaceId, filter), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListProposals).toHaveBeenCalledWith(workspaceId, filter);
  });

  it('transitions to isError with the thrown error when apiClient.listProposals rejects', async () => {
    const error = new Error('boom');
    mockedListProposals.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useProposalsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useDecideProposalMutation', () => {
  const workspaceId = 'ws-1';
  const variables = {
    proposalId: 'proposal-1',
    decisions: [{ actionId: 'action-1', decision: 'approved' as const }],
  };

  function makeDecideResult(): { results: DecideActionResult[] } {
    return {
      results: [{ actionId: 'action-1', status: 'executed', createdCount: 1, totalCount: 1 }],
    };
  }

  it('calls apiClient.decideProposal with the workspace id, proposalId and decisions on mutate', async () => {
    mockedDecideProposal.mockResolvedValueOnce(makeDecideResult());
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDecideProposalMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedDecideProposal).toHaveBeenCalledWith(
      workspaceId,
      variables.proposalId,
      variables.decisions,
    );
  });

  it('invalidates cached ["proposals", workspaceId, ...] queries BY PREFIX once the mutation succeeds', async () => {
    mockedDecideProposal.mockResolvedValueOnce(makeDecideResult());
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDecideProposalMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    const invalidatedKey = filters?.queryKey ?? [];
    expect(invalidatedKey.slice(0, 2)).toEqual(['proposals', workspaceId]);
  });

  it('resolves with the { results } shape returned by apiClient.decideProposal', async () => {
    const decideResult = makeDecideResult();
    mockedDecideProposal.mockResolvedValueOnce(decideResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDecideProposalMutation(workspaceId), {
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
