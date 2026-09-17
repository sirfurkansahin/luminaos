import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useAcceptFederationLinkMutation as useAcceptFederationLinkMutationModuleExport,
  useFederationLinksQuery as useFederationLinksQueryModuleExport,
  useInitiateFederationLinkMutation as useInitiateFederationLinkMutationModuleExport,
  useRevokeFederationLinkMutation as useRevokeFederationLinkMutationModuleExport,
} from './useFederationLinksQuery.js';

/**
 * F3-T14 PR3 (ADR-0048 §b/§c, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useFederationLinksQuery.ts AND add the following new
 * exports to apps/web/src/lib/apiClient.ts to satisfy these tests; that's the
 * expected TDD red state):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export type FederationLinkStatus = 'pending' | 'active' | 'revoked';
 *   export interface FederationLink {
 *     id: string; initiatorWorkspaceId: string; counterpartWorkspaceId: string;
 *     pairKey: string; status: FederationLinkStatus; initiatedByUserId: string;
 *     acceptedByUserId: string | null; revokedByUserId: string | null;
 *     initiatorAuditStreamId: string; counterpartAuditStreamId: string;
 *     createdAt: string; acceptedAt: string | null; revokedAt: string | null;
 *   }
 *   export function listFederationLinks(workspaceId: string): Promise<{ links: FederationLink[] }>;
 *   export function initiateFederationLink(
 *     workspaceId: string, counterpartWorkspaceId: string,
 *   ): Promise<{ link: FederationLink }>;
 *   export function acceptFederationLink(
 *     workspaceId: string, linkId: string,
 *   ): Promise<{ link: FederationLink }>;
 *   export function revokeFederationLink(
 *     workspaceId: string, linkId: string,
 *   ): Promise<{ link: FederationLink }>;
 *
 *   // apps/web/src/hooks/useFederationLinksQuery.ts
 *   export function useFederationLinksQuery(workspaceId: string): UseQueryResult<{ links: FederationLink[] }>;
 *       // queryKey MUST be exactly ['federation-links', workspaceId].
 *   export function useInitiateFederationLinkMutation(workspaceId: string):
 *     UseMutationResult<{ link: FederationLink }, Error, { counterpartWorkspaceId: string }>;
 *       // mutationFn delegates to initiateFederationLink(workspaceId, variables.counterpartWorkspaceId).
 *       // onSuccess invalidates ['federation-links', workspaceId] (exact key).
 *   export function useAcceptFederationLinkMutation(workspaceId: string):
 *     UseMutationResult<{ link: FederationLink }, Error, string>;
 *       // mutationFn delegates to acceptFederationLink(workspaceId, linkId). variables IS the linkId string.
 *       // onSuccess invalidates ['federation-links', workspaceId].
 *   export function useRevokeFederationLinkMutation(workspaceId: string):
 *     UseMutationResult<{ link: FederationLink }, Error, string>;
 *       // mutationFn delegates to revokeFederationLink(workspaceId, linkId). variables IS the linkId string.
 *       // onSuccess invalidates ['federation-links', workspaceId].
 *
 * `./useFederationLinksQuery.ts` does not exist yet, so a bare `import {
 * useFederationLinksQuery } from './useFederationLinksQuery.js'` binding
 * would otherwise type as `any`, cascading `@typescript-eslint/no-unsafe-*`
 * errors through every call site below (same lint-avoidance technique as
 * `ExternalSearchResultChip.test.tsx`'s `ModuleExport as unknown as <shape>`
 * pattern, applied here to four hook functions instead of a component). The
 * `FederationLink` shape is declared locally rather than type-imported from
 * apiClient.ts (which also does not yet export it) for the same reason.
 * apiClient.ts's four new functions are never imported by name here either —
 * `vi.mock` below supplies them directly via `vi.hoisted`-created mocks, so
 * there is nothing for a top-level named import to fail to resolve against.
 */

type FederationLinkStatus = 'pending' | 'active' | 'revoked';

interface FederationLink {
  id: string;
  initiatorWorkspaceId: string;
  counterpartWorkspaceId: string;
  pairKey: string;
  status: FederationLinkStatus;
  initiatedByUserId: string;
  acceptedByUserId: string | null;
  revokedByUserId: string | null;
  initiatorAuditStreamId: string;
  counterpartAuditStreamId: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

const {
  mockedListFederationLinks,
  mockedInitiateFederationLink,
  mockedAcceptFederationLink,
  mockedRevokeFederationLink,
} = vi.hoisted(() => {
  return {
    mockedListFederationLinks: vi.fn(),
    mockedInitiateFederationLink: vi.fn(),
    mockedAcceptFederationLink: vi.fn(),
    mockedRevokeFederationLink: vi.fn(),
  };
});

vi.mock('../lib/apiClient.js', () => ({
  listFederationLinks: mockedListFederationLinks,
  initiateFederationLink: mockedInitiateFederationLink,
  acceptFederationLink: mockedAcceptFederationLink,
  revokeFederationLink: mockedRevokeFederationLink,
}));

const useFederationLinksQuery = useFederationLinksQueryModuleExport;

const useInitiateFederationLinkMutation = useInitiateFederationLinkMutationModuleExport;

const useAcceptFederationLinkMutation = useAcceptFederationLinkMutationModuleExport;

const useRevokeFederationLinkMutation = useRevokeFederationLinkMutationModuleExport;

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

function makeLinkFixture(overrides: Partial<FederationLink> = {}): FederationLink {
  return {
    id: 'link-1',
    initiatorWorkspaceId: 'ws-1',
    counterpartWorkspaceId: 'ws-2',
    pairKey: 'ws-1:ws-2',
    status: 'pending',
    initiatedByUserId: 'user-1',
    acceptedByUserId: null,
    revokedByUserId: null,
    initiatorAuditStreamId: 'stream-1',
    counterpartAuditStreamId: 'stream-2',
    createdAt: '2026-09-01T00:00:00.000Z',
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFederationLinksQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listFederationLinks with the workspace id', async () => {
    const link = makeLinkFixture();
    mockedListFederationLinks.mockResolvedValueOnce({ links: [link] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationLinksQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListFederationLinks).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ links: [link] });
  });

  it('exposes the exact ["federation-links", workspaceId] query key', async () => {
    const link = makeLinkFixture();
    mockedListFederationLinks.mockResolvedValueOnce({ links: [link] });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationLinksQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['federation-links', workspaceId]);
    expect(cached).toEqual({ links: [link] });
  });

  it('transitions to isError with the thrown error when apiClient.listFederationLinks rejects', async () => {
    const error = new Error('boom');
    mockedListFederationLinks.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationLinksQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useInitiateFederationLinkMutation', () => {
  const workspaceId = 'ws-1';
  const variables = { counterpartWorkspaceId: 'ws-2' };

  it('calls apiClient.initiateFederationLink with the workspace id and counterpartWorkspaceId on mutate', async () => {
    mockedInitiateFederationLink.mockResolvedValueOnce({ link: makeLinkFixture() });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useInitiateFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedInitiateFederationLink).toHaveBeenCalledWith(
      workspaceId,
      variables.counterpartWorkspaceId,
    );
  });

  it('invalidates the exact ["federation-links", workspaceId] query once the mutation succeeds', async () => {
    mockedInitiateFederationLink.mockResolvedValueOnce({ link: makeLinkFixture() });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useInitiateFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['federation-links', workspaceId] });
  });

  it('transitions to isError with the thrown error when apiClient.initiateFederationLink rejects (e.g. 403 non-admin)', async () => {
    const error = new Error('Forbidden');
    mockedInitiateFederationLink.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useInitiateFederationLinkMutation(workspaceId), {
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
});

describe('useAcceptFederationLinkMutation', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';

  it('calls apiClient.acceptFederationLink with the workspace id and linkId on mutate', async () => {
    mockedAcceptFederationLink.mockResolvedValueOnce({
      link: makeLinkFixture({ status: 'active' }),
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAcceptFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(linkId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedAcceptFederationLink).toHaveBeenCalledWith(workspaceId, linkId);
  });

  it('invalidates the exact ["federation-links", workspaceId] query once the mutation succeeds', async () => {
    mockedAcceptFederationLink.mockResolvedValueOnce({
      link: makeLinkFixture({ status: 'active' }),
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useAcceptFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(linkId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['federation-links', workspaceId] });
  });

  it('transitions to isError when apiClient.acceptFederationLink rejects (e.g. initiator cannot accept own proposal)', async () => {
    const error = new Error('Forbidden');
    mockedAcceptFederationLink.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAcceptFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(linkId);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useRevokeFederationLinkMutation', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';

  it('calls apiClient.revokeFederationLink with the workspace id and linkId on mutate', async () => {
    mockedRevokeFederationLink.mockResolvedValueOnce({
      link: makeLinkFixture({ status: 'revoked' }),
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useRevokeFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(linkId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedRevokeFederationLink).toHaveBeenCalledWith(workspaceId, linkId);
  });

  it('invalidates the exact ["federation-links", workspaceId] query once the mutation succeeds', async () => {
    mockedRevokeFederationLink.mockResolvedValueOnce({
      link: makeLinkFixture({ status: 'revoked' }),
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRevokeFederationLinkMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(linkId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['federation-links', workspaceId] });
  });
});
