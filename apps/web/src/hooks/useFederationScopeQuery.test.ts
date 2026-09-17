import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useAddFederationScopeObjectMutation as useAddFederationScopeObjectMutationModuleExport,
  useFederationScopeQuery as useFederationScopeQueryModuleExport,
  useRemoveFederationScopeObjectMutation as useRemoveFederationScopeObjectMutationModuleExport,
} from './useFederationScopeQuery.js';

/**
 * F3-T14 PR3 (ADR-0048 §e, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useFederationScopeQuery.ts AND add the following new
 * exports to apps/web/src/lib/apiClient.ts):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface FederationScopeObject {
 *     id: string; federationLinkId: string; objectId: string;
 *     ownerWorkspaceId: string; addedByUserId: string; addedAt: string;
 *     removedAt: string | null;
 *   }
 *   export function listFederationScopeObjects(
 *     workspaceId: string, linkId: string,
 *   ): Promise<{ scopeObjects: FederationScopeObject[] }>;
 *   export function addFederationScopeObject(
 *     workspaceId: string, linkId: string, objectId: string,
 *   ): Promise<{ scopeObject: FederationScopeObject }>;
 *   export function removeFederationScopeObject(
 *     workspaceId: string, linkId: string, objectId: string,
 *   ): Promise<void>;
 *
 *   // apps/web/src/hooks/useFederationScopeQuery.ts
 *   export function useFederationScopeQuery(
 *     workspaceId: string, linkId: string,
 *   ): UseQueryResult<{ scopeObjects: FederationScopeObject[] }>;
 *       // queryKey MUST be exactly ['federation-scope', workspaceId, linkId].
 *   export function useAddFederationScopeObjectMutation(workspaceId: string, linkId: string):
 *     UseMutationResult<{ scopeObject: FederationScopeObject }, Error, { objectId: string }>;
 *       // mutationFn delegates to addFederationScopeObject(workspaceId, linkId, variables.objectId).
 *       // onSuccess invalidates ['federation-scope', workspaceId, linkId] (exact key).
 *   export function useRemoveFederationScopeObjectMutation(workspaceId: string, linkId: string):
 *     UseMutationResult<void, Error, string>;
 *       // mutationFn delegates to removeFederationScopeObject(workspaceId, linkId, objectId).
 *       // variables IS the objectId string.
 *       // onSuccess invalidates ['federation-scope', workspaceId, linkId].
 *
 * `./useFederationScopeQuery.ts` does not exist yet — see
 * `useFederationLinksQuery.test.ts`'s identical header comment for the
 * `ModuleExport as unknown as <shape>` lint-avoidance rationale, applied here
 * to this file's three hook functions. apiClient.ts's three new functions are
 * never imported by name here either — `vi.mock` below supplies them via
 * `vi.hoisted`-created mocks.
 */

interface FederationScopeObject {
  id: string;
  federationLinkId: string;
  objectId: string;
  ownerWorkspaceId: string;
  addedByUserId: string;
  addedAt: string;
  removedAt: string | null;
}

const {
  mockedListFederationScopeObjects,
  mockedAddFederationScopeObject,
  mockedRemoveFederationScopeObject,
} = vi.hoisted(() => {
  return {
    mockedListFederationScopeObjects: vi.fn(),
    mockedAddFederationScopeObject: vi.fn(),
    mockedRemoveFederationScopeObject: vi.fn(),
  };
});

vi.mock('../lib/apiClient.js', () => ({
  listFederationScopeObjects: mockedListFederationScopeObjects,
  addFederationScopeObject: mockedAddFederationScopeObject,
  removeFederationScopeObject: mockedRemoveFederationScopeObject,
}));

const useFederationScopeQuery = useFederationScopeQueryModuleExport;

const useAddFederationScopeObjectMutation = useAddFederationScopeObjectMutationModuleExport;

const useRemoveFederationScopeObjectMutation = useRemoveFederationScopeObjectMutationModuleExport;

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

function makeScopeObjectFixture(
  overrides: Partial<FederationScopeObject> = {},
): FederationScopeObject {
  return {
    id: 'scope-1',
    federationLinkId: 'link-1',
    objectId: 'obj-1',
    ownerWorkspaceId: 'ws-1',
    addedByUserId: 'user-1',
    addedAt: '2026-09-01T00:00:00.000Z',
    removedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFederationScopeQuery', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';

  it('calls apiClient.listFederationScopeObjects with the workspace id and linkId', async () => {
    const scopeObject = makeScopeObjectFixture();
    mockedListFederationScopeObjects.mockResolvedValueOnce({ scopeObjects: [scopeObject] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationScopeQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListFederationScopeObjects).toHaveBeenCalledWith(workspaceId, linkId);
    expect(result.current.data).toEqual({ scopeObjects: [scopeObject] });
  });

  it('exposes the exact ["federation-scope", workspaceId, linkId] query key', async () => {
    const scopeObject = makeScopeObjectFixture();
    mockedListFederationScopeObjects.mockResolvedValueOnce({ scopeObjects: [scopeObject] });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationScopeQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['federation-scope', workspaceId, linkId]);
    expect(cached).toEqual({ scopeObjects: [scopeObject] });
  });

  it('transitions to isError with the thrown error when apiClient.listFederationScopeObjects rejects', async () => {
    const error = new Error('boom');
    mockedListFederationScopeObjects.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationScopeQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useAddFederationScopeObjectMutation', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';
  const variables = { objectId: 'obj-2' };

  it('calls apiClient.addFederationScopeObject with the workspace id, linkId and objectId on mutate', async () => {
    mockedAddFederationScopeObject.mockResolvedValueOnce({
      scopeObject: makeScopeObjectFixture({ objectId: variables.objectId }),
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAddFederationScopeObjectMutation(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedAddFederationScopeObject).toHaveBeenCalledWith(
      workspaceId,
      linkId,
      variables.objectId,
    );
  });

  it('invalidates the exact ["federation-scope", workspaceId, linkId] query once the mutation succeeds', async () => {
    mockedAddFederationScopeObject.mockResolvedValueOnce({
      scopeObject: makeScopeObjectFixture({ objectId: variables.objectId }),
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useAddFederationScopeObjectMutation(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['federation-scope', workspaceId, linkId],
    });
  });

  it('transitions to isError when apiClient.addFederationScopeObject rejects (e.g. objectId not found)', async () => {
    const error = new Error('Lumina Object not found');
    mockedAddFederationScopeObject.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useAddFederationScopeObjectMutation(workspaceId, linkId), {
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

describe('useRemoveFederationScopeObjectMutation', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';
  const objectId = 'obj-1';

  it('calls apiClient.removeFederationScopeObject with the workspace id, linkId and objectId on mutate', async () => {
    mockedRemoveFederationScopeObject.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useRemoveFederationScopeObjectMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate(objectId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedRemoveFederationScopeObject).toHaveBeenCalledWith(workspaceId, linkId, objectId);
  });

  it('invalidates the exact ["federation-scope", workspaceId, linkId] query once the mutation succeeds', async () => {
    mockedRemoveFederationScopeObject.mockResolvedValueOnce(undefined);
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () => useRemoveFederationScopeObjectMutation(workspaceId, linkId),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate(objectId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['federation-scope', workspaceId, linkId],
    });
  });
});
