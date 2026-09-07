import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentsQuery, useRegisterAgentMutation } from './useAgentsQuery.js';
import { listAgents, registerAgent } from '../lib/apiClient.js';

import type { Agent } from '../lib/apiClient.js';

/**
 * F3-T3 PR7a (ADR-0037 §b/§d) — TDD red step. Contract under test (not yet
 * implemented — implementer must build apps/web/src/hooks/useAgentsQuery.ts
 * AND add the following new exports to apps/web/src/lib/apiClient.ts to
 * satisfy these tests; that's the expected TDD red state), mirroring
 * useMcpGrantsQuery.ts/.test.ts's exact query-key/invalidation-by-prefix
 * shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface Agent {
 *     id: string; workspaceId: string; name: string; agentIdentifier: string;
 *     lifecycle: 'active' | 'deactivated'; createdAt: string;
 *   }
 *   export function listAgents(workspaceId: string): Promise<{ agents: Agent[] }>;
 *     // GET /workspaces/:workspaceId/agents
 *   export function registerAgent(
 *     workspaceId: string, input: { name: string; agentIdentifier: string },
 *   ): Promise<{ agent: Agent }>;
 *     // POST /workspaces/:workspaceId/agents, body: input
 *
 *   // apps/web/src/hooks/useAgentsQuery.ts
 *   export function useAgentsQuery(workspaceId: string): UseQueryResult<{ agents: Agent[] }>;
 *     // queryKey MUST be (or start with) ['agents', workspaceId].
 *   export function useRegisterAgentMutation(workspaceId: string):
 *     UseMutationResult<{ agent: Agent }, Error, { name: string; agentIdentifier: string }>;
 *       // mutationFn delegates to registerAgent(workspaceId, variables).
 *       // onSuccess invalidates BY PREFIX ['agents', workspaceId] queries
 *       // (assert the invalidated queryKey STARTS WITH ['agents', workspaceId],
 *       // not that it equals it exactly).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the two new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useMcpGrantsQuery.test.ts's identical rationale).
 * Real route verified against
 * apps/server/src/agent-runtime/agent-directory.controller.ts:
 * `@Controller('workspaces/:workspaceId/agents')` with `@Post()`/`@Get()`
 * handlers returning `{ agent: Agent }` / `{ agents: Agent[] }` respectively.
 */

vi.mock('../lib/apiClient.js', () => ({
  listAgents: vi.fn(),
  registerAgent: vi.fn(),
}));

const mockedListAgents = vi.mocked(listAgents);
const mockedRegisterAgent = vi.mocked(registerAgent);

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

function makeAgentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    workspaceId: 'ws-1',
    name: 'ReportBot',
    agentIdentifier: 'report-bot@luminaos.internal',
    lifecycle: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useAgentsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listAgents with the workspace id', async () => {
    const agent = makeAgentFixture();
    mockedListAgents.mockResolvedValueOnce({ agents: [agent] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAgentsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListAgents).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ agents: [agent] });
  });

  it('transitions to isError with the thrown error when apiClient.listAgents rejects', async () => {
    const error = new Error('boom');
    mockedListAgents.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAgentsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useRegisterAgentMutation', () => {
  const workspaceId = 'ws-1';
  const variables = { name: 'ReportBot', agentIdentifier: 'report-bot@luminaos.internal' };

  it('calls apiClient.registerAgent with the workspace id and input on mutate', async () => {
    const agent = makeAgentFixture();
    mockedRegisterAgent.mockResolvedValueOnce({ agent });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useRegisterAgentMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedRegisterAgent).toHaveBeenCalledWith(workspaceId, variables);
  });

  it('invalidates cached ["agents", workspaceId, ...] queries BY PREFIX once the mutation succeeds', async () => {
    const agent = makeAgentFixture();
    mockedRegisterAgent.mockResolvedValueOnce({ agent });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRegisterAgentMutation(workspaceId), {
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
    expect(invalidatedKey.slice(0, 2)).toEqual(['agents', workspaceId]);
  });

  it('resolves with the { agent } shape returned by apiClient.registerAgent', async () => {
    const agent = makeAgentFixture({ id: 'agent-new' });
    mockedRegisterAgent.mockResolvedValueOnce({ agent });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useRegisterAgentMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ agent });
  });
});
