import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useCreateFederationCredentialMutation as useCreateFederationCredentialMutationModuleExport,
  useRevokeFederationCredentialMutation as useRevokeFederationCredentialMutationModuleExport,
} from './useFederationCredentialsMutation.js';

/**
 * F3-T14 PR3 (ADR-0048 §d, İNSAN ONAYLI, spec Kabul Kriterleri) — TDD red
 * step. Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useFederationCredentialsMutation.ts AND add the
 * following new exports to apps/web/src/lib/apiClient.ts):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface FederationLinkCredential {
 *     id: string; federationLinkId: string; granteeWorkspaceId: string;
 *     name: string; tokenPrefix: string; createdByUserId: string;
 *     createdAt: string; expiresAt: string | null; revokedAt: string | null;
 *   }
 *   export interface CreateFederationCredentialResult {
 *     credential: FederationLinkCredential; rawToken: string;
 *   }
 *   export function createFederationCredential(
 *     workspaceId: string, linkId: string, name: string,
 *     expiresAtDays?: 30 | 90 | 365,
 *   ): Promise<CreateFederationCredentialResult>;
 *   export function revokeFederationCredential(
 *     workspaceId: string, linkId: string, credentialId: string,
 *   ): Promise<void>;
 *
 *   // apps/web/src/hooks/useFederationCredentialsMutation.ts
 *   export function useCreateFederationCredentialMutation(workspaceId: string, linkId: string):
 *     UseMutationResult<
 *       CreateFederationCredentialResult, Error,
 *       { name: string; expiresAtDays?: 30 | 90 | 365 }
 *     >;
 *       // mutationFn delegates to createFederationCredential(workspaceId, linkId,
 *       // variables.name, variables.expiresAtDays) -- NO query invalidation is
 *       // asserted here: unlike links/scope, there is no server-side GET list
 *       // endpoint for credentials (ADR-0048 §d/spec PR2 controller surface --
 *       // `POST .../credentials` and `POST .../credentials/:id/revoke` only), so
 *       // this codebase's `FederationLinksPanel` tracks created credentials in
 *       // local component state, not via a TanStack Query cache.
 *   export function useRevokeFederationCredentialMutation(workspaceId: string, linkId: string):
 *     UseMutationResult<void, Error, string>;
 *       // mutationFn delegates to revokeFederationCredential(workspaceId, linkId,
 *       // credentialId). variables IS the credentialId string.
 *
 * `./useFederationCredentialsMutation.ts` does not exist yet — see
 * `useFederationLinksQuery.test.ts`'s identical header comment for the
 * `ModuleExport as unknown as <shape>` lint-avoidance rationale, applied here
 * to this file's two hook functions. apiClient.ts's two new functions are
 * never imported by name here either — `vi.mock` below supplies them via
 * `vi.hoisted`-created mocks.
 */

interface FederationLinkCredential {
  id: string;
  federationLinkId: string;
  granteeWorkspaceId: string;
  name: string;
  tokenPrefix: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

const { mockedCreateFederationCredential, mockedRevokeFederationCredential } = vi.hoisted(() => {
  return {
    mockedCreateFederationCredential: vi.fn(),
    mockedRevokeFederationCredential: vi.fn(),
  };
});

vi.mock('../lib/apiClient.js', () => ({
  createFederationCredential: mockedCreateFederationCredential,
  revokeFederationCredential: mockedRevokeFederationCredential,
}));

const useCreateFederationCredentialMutation = useCreateFederationCredentialMutationModuleExport;

const useRevokeFederationCredentialMutation = useRevokeFederationCredentialMutationModuleExport;

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

  return { Wrapper };
}

function makeCredentialFixture(
  overrides: Partial<FederationLinkCredential> = {},
): FederationLinkCredential {
  return {
    id: 'cred-1',
    federationLinkId: 'link-1',
    granteeWorkspaceId: 'ws-2',
    name: 'Acme Corp -- paylaşılan proje X',
    tokenPrefix: 'Ab3xK9mZ1234',
    createdByUserId: 'user-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-12-30T00:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCreateFederationCredentialMutation', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';

  it('calls apiClient.createFederationCredential with the workspace id, linkId, name and expiresAtDays on mutate', async () => {
    const rawToken = 'RAW_TOKEN_FIXTURE_VALUE';
    mockedCreateFederationCredential.mockResolvedValueOnce({
      credential: makeCredentialFixture(),
      rawToken,
    });
    const { Wrapper } = createWrapper();
    const variables = { name: 'Acme Corp erişimi', expiresAtDays: 30 as const };

    const { result } = renderHook(
      () => useCreateFederationCredentialMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCreateFederationCredential).toHaveBeenCalledWith(
      workspaceId,
      linkId,
      variables.name,
      variables.expiresAtDays,
    );
  });

  it('calls apiClient.createFederationCredential with expiresAtDays undefined when the caller omits it (server defaults to 90)', async () => {
    mockedCreateFederationCredential.mockResolvedValueOnce({
      credential: makeCredentialFixture(),
      rawToken: 'RAW_TOKEN_FIXTURE_VALUE',
    });
    const { Wrapper } = createWrapper();
    const variables = { name: 'Acme Corp erişimi' };

    const { result } = renderHook(
      () => useCreateFederationCredentialMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCreateFederationCredential).toHaveBeenCalledWith(
      workspaceId,
      linkId,
      variables.name,
      undefined,
    );
  });

  it('resolves with the { credential, rawToken } shape returned by apiClient.createFederationCredential', async () => {
    const rawToken = 'RAW_TOKEN_FIXTURE_VALUE';
    const createResult = { credential: makeCredentialFixture(), rawToken };
    mockedCreateFederationCredential.mockResolvedValueOnce(createResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useCreateFederationCredentialMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate({ name: 'Acme Corp erişimi' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(createResult);
  });

  it('transitions to isError with the thrown error when apiClient.createFederationCredential rejects (e.g. 403 non-admin)', async () => {
    const error = new Error('Forbidden');
    mockedCreateFederationCredential.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useCreateFederationCredentialMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate({ name: 'Acme Corp erişimi' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useRevokeFederationCredentialMutation', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';
  const credentialId = 'cred-1';

  it('calls apiClient.revokeFederationCredential with the workspace id, linkId and credentialId on mutate', async () => {
    mockedRevokeFederationCredential.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useRevokeFederationCredentialMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate(credentialId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedRevokeFederationCredential).toHaveBeenCalledWith(
      workspaceId,
      linkId,
      credentialId,
    );
  });

  it('transitions to isError with the thrown error when apiClient.revokeFederationCredential rejects', async () => {
    const error = new Error('Not Found');
    mockedRevokeFederationCredential.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useRevokeFederationCredentialMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate(credentialId);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});
