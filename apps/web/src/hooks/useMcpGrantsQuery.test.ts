import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useCreateMcpGrantMutation,
  useMcpGrantsQuery,
  useRevokeMcpGrantMutation,
} from './useMcpGrantsQuery.js';
import { createMcpGrant, listMcpGrants, revokeMcpGrant } from '../lib/apiClient.js';

import type { CreateMcpClientGrantResult, McpClientGrant } from '../lib/apiClient.js';

/**
 * F2-T12 PR2 (ADR-0028 §k, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useMcpGrantsQuery.ts AND add the following new exports
 * to apps/web/src/lib/apiClient.ts to satisfy these tests; that's the
 * expected TDD red state):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface McpClientGrant {
 *     id: string; name: string; tokenPrefix: string; createdAt: string;
 *     expiresAt: string | null; revokedAt: string | null;
 *   }
 *   export interface CreateMcpClientGrantResult {
 *     grant: McpClientGrant; rawToken: string;
 *   }
 *   export function listMcpGrants(workspaceId: string): Promise<{ grants: McpClientGrant[] }>;
 *   export function createMcpGrant(
 *     workspaceId: string, name: string, expiresAtDays: 30 | 90 | 365,
 *   ): Promise<CreateMcpClientGrantResult>;
 *   export function revokeMcpGrant(workspaceId: string, grantId: string): Promise<void>;
 *
 *   // apps/web/src/hooks/useMcpGrantsQuery.ts
 *   export function useMcpGrantsQuery(workspaceId: string):
 *     UseQueryResult<{ grants: McpClientGrant[] }>;
 *       // thin wrapper around useQuery — queryFn delegates to
 *       // apiClient.ts's listMcpGrants(workspaceId). queryKey MUST be (or
 *       // start with) ['mcp-grants', workspaceId] so the mutation hooks
 *       // below can invalidate it by key prefix (mirrors
 *       // useMemoryRecordsQuery.ts's exact query-key/invalidation shape).
 *
 *   export function useCreateMcpGrantMutation(workspaceId: string):
 *     UseMutationResult<
 *       CreateMcpClientGrantResult, Error, { name: string; expiresAtDays: 30 | 90 | 365 }
 *     >;
 *       // mutationFn delegates to apiClient.ts's
 *       // createMcpGrant(workspaceId, variables.name, variables.expiresAtDays).
 *       // onSuccess invalidates ['mcp-grants', workspaceId] queries.
 *
 *   export function useRevokeMcpGrantMutation(workspaceId: string):
 *     UseMutationResult<void, Error, string>; // variables = grantId
 *       // mutationFn delegates to apiClient.ts's
 *       // revokeMcpGrant(workspaceId, grantId). onSuccess invalidates
 *       // ['mcp-grants', workspaceId] queries.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the three new functions above is pinned only by this file (there is no
 * separate apiClient.test.ts in this repo, per apiClient.ts's own existing
 * convention of being exercised only through its consumers' tests).
 */

vi.mock('../lib/apiClient.js', () => ({
  listMcpGrants: vi.fn(),
  createMcpGrant: vi.fn(),
  revokeMcpGrant: vi.fn(),
}));

const mockedListMcpGrants = vi.mocked(listMcpGrants);
const mockedCreateMcpGrant = vi.mocked(createMcpGrant);
const mockedRevokeMcpGrant = vi.mocked(revokeMcpGrant);

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

function makeGrantFixture(overrides: Partial<McpClientGrant> = {}): McpClientGrant {
  return {
    id: 'grant-1',
    name: "Kişisel Claude Desktop'ım",
    tokenPrefix: 'Ab3xK9mZ1234',
    createdAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMcpGrantsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listMcpGrants with the workspace id', async () => {
    const grant = makeGrantFixture();
    mockedListMcpGrants.mockResolvedValueOnce({ grants: [grant] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useMcpGrantsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListMcpGrants).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ grants: [grant] });
  });

  it('transitions to isError with the thrown error when apiClient.listMcpGrants rejects', async () => {
    const error = new Error('boom');
    mockedListMcpGrants.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useMcpGrantsQuery(workspaceId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useCreateMcpGrantMutation', () => {
  const workspaceId = 'ws-1';
  const variables = { name: "Kişisel Claude Desktop'ım", expiresAtDays: 90 as const };

  function makeCreateResult(): CreateMcpClientGrantResult {
    return { grant: makeGrantFixture(), rawToken: 'Ab3xK9mZ_FIXTURE_RAW_TOKEN_VALUE' };
  }

  it('calls apiClient.createMcpGrant with the workspace id, name and expiresAtDays on mutate', async () => {
    mockedCreateMcpGrant.mockResolvedValueOnce(makeCreateResult());
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateMcpGrantMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCreateMcpGrant).toHaveBeenCalledWith(workspaceId, variables.name, 90);
  });

  it('invalidates cached ["mcp-grants", workspaceId] queries once the mutation succeeds', async () => {
    mockedCreateMcpGrant.mockResolvedValueOnce(makeCreateResult());
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateMcpGrantMutation(workspaceId), {
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
    expect(filters?.queryKey?.[0]).toBe('mcp-grants');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });

  it('resolves with the { grant, rawToken } shape returned by apiClient.createMcpGrant (the one-time raw token)', async () => {
    const createResult = makeCreateResult();
    mockedCreateMcpGrant.mockResolvedValueOnce(createResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateMcpGrantMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(createResult);
  });
});

describe('useRevokeMcpGrantMutation', () => {
  const workspaceId = 'ws-1';
  const grantId = 'grant-1';

  it('calls apiClient.revokeMcpGrant with the workspace id and grant id on mutate', async () => {
    mockedRevokeMcpGrant.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useRevokeMcpGrantMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(grantId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedRevokeMcpGrant).toHaveBeenCalledWith(workspaceId, grantId);
  });

  it('invalidates cached ["mcp-grants", workspaceId] queries once the mutation succeeds', async () => {
    mockedRevokeMcpGrant.mockResolvedValueOnce(undefined);
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRevokeMcpGrantMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(grantId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('mcp-grants');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});
