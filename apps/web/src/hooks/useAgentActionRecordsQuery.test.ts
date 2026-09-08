import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentActionRecordsQuery } from './useAgentActionRecordsQuery.js';
import { listAgentActionRecords } from '../lib/apiClient.js';

/**
 * F3-T4 PR4 (ADR-0038 §h, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useAgentActionRecordsQuery.ts AND add the following new
 * exports to apps/web/src/lib/apiClient.ts to satisfy these tests; that's
 * the expected TDD red state), mirroring `useProposalsQuery.ts`'s
 * `useProposalsQuery` half exactly (this ledger has NO write UI at all, per
 * ADR-0038 §g/§h, so there is no mutation counterpart to mirror):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export type ActionProvenance = 'decided' | 'autonomous';
 *   export type AgentActionOutcome =
 *     'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';
 *   export type ActionResourceReference =
 *     | { kind: 'object'; objectId: string }
 *     | { kind: 'comment'; commentId: string }
 *     | { kind: 'meeting'; meetingId: string }
 *     | { kind: 'agent'; agentIdentifier: string }
 *     | { kind: 'external'; label: string };
 *   export interface RollbackPlan {
 *     kind: 'delete' | 'revertFieldValue' | 'revokePermission' | 'manual' | 'none';
 *     targetResource?: ActionResourceReference;
 *     description: string;
 *   }
 *   export interface AgentActionRecord {
 *     id: string; workspaceId: string; provenance: ActionProvenance;
 *     actor: { type: 'user' | 'agent' | 'system'; id: string };
 *     actionType: string; intent: string; rationale: string;
 *     resources: ActionResourceReference[]; rollbackPlan: RollbackPlan;
 *     outcome: AgentActionOutcome; resultRef: ActionResourceReference | null;
 *     causationEventId: string | null; occurredAt: string;
 *   }
 *   export function listAgentActionRecords(
 *     workspaceId: string,
 *   ): Promise<{ records: AgentActionRecord[] }>;
 *       // GET /workspaces/:workspaceId/agent-action-records
 *
 *   // apps/web/src/hooks/useAgentActionRecordsQuery.ts
 *   export function useAgentActionRecordsQuery(
 *     workspaceId: string,
 *   ): UseQueryResult<{ records: AgentActionRecord[] }>;
 *       // thin wrapper around useQuery — queryFn delegates to
 *       // apiClient.ts's listAgentActionRecords(workspaceId). queryKey MUST
 *       // be exactly ['agentActionRecords', workspaceId].
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the new function above is pinned only by this file, per apiClient.ts's
 * existing convention of being exercised only through its consumers' tests
 * (see useMcpGrantsQuery.test.ts's identical rationale; there is no separate
 * apiClient.test.ts coverage for listAgentActionRecords).
 */

type FixtureResourceReference = { kind: 'object'; objectId: string };

interface FixtureRecord {
  id: string;
  workspaceId: string;
  provenance: 'decided' | 'autonomous';
  actor: { type: 'user' | 'agent' | 'system'; id: string };
  actionType: string;
  intent: string;
  rationale: string;
  resources: FixtureResourceReference[];
  rollbackPlan: {
    kind: 'delete' | 'revertFieldValue' | 'revokePermission' | 'manual' | 'none';
    description: string;
  };
  outcome: 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';
  resultRef: FixtureResourceReference | null;
  causationEventId: string | null;
  occurredAt: string;
}

vi.mock('../lib/apiClient.js', () => ({
  listAgentActionRecords: vi.fn(),
}));

const mockedListAgentActionRecords = vi.mocked(listAgentActionRecords);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { queryClient, Wrapper };
}

function makeRecordFixture(overrides: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    id: 'record-1',
    workspaceId: 'ws-1',
    provenance: 'decided',
    actor: { type: 'user', id: 'user-1' },
    actionType: 'createTask',
    intent: "Ayşe için 'Rapor gönder' görevi oluştur",
    rationale: 'Toplantıda bahsedildi',
    resources: [{ kind: 'object', objectId: 'obj-1' }],
    rollbackPlan: { kind: 'delete', description: 'Oluşturulan görevi sil.' },
    outcome: 'succeeded',
    resultRef: { kind: 'object', objectId: 'obj-1' },
    causationEventId: 'event-1',
    occurredAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useAgentActionRecordsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listAgentActionRecords with exactly the workspace id', async () => {
    const record = makeRecordFixture();
    mockedListAgentActionRecords.mockResolvedValueOnce({ records: [record] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAgentActionRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListAgentActionRecords).toHaveBeenCalledWith(workspaceId);
    expect(mockedListAgentActionRecords).toHaveBeenCalledTimes(1);
  });

  it('resolves with the { records } shape returned by apiClient.listAgentActionRecords', async () => {
    const record = makeRecordFixture();
    mockedListAgentActionRecords.mockResolvedValueOnce({ records: [record] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAgentActionRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ records: [record] });
  });

  it('caches its result under the exact queryKey ["agentActionRecords", workspaceId]', async () => {
    const record = makeRecordFixture();
    mockedListAgentActionRecords.mockResolvedValueOnce({ records: [record] });
    const { Wrapper, queryClient } = createWrapper();

    const { result } = renderHook(() => useAgentActionRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryData(['agentActionRecords', workspaceId])).toEqual({
      records: [record],
    });
  });

  it('transitions to isError with the thrown error when apiClient.listAgentActionRecords rejects', async () => {
    const error = new Error('boom');
    mockedListAgentActionRecords.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAgentActionRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });

  it('starts in a loading state before the query resolves', () => {
    mockedListAgentActionRecords.mockReturnValueOnce(new Promise(() => {}));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAgentActionRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    expect(result.current.isLoading).toBe(true);
  });
});
