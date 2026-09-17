import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFederationAuditLogQuery as useFederationAuditLogQueryModuleExport } from './useFederationAuditLogQuery.js';

/**
 * F3-T14 PR3 (ADR-0048 §h/RBAC özeti "member+", spec Kabul Kriterleri) — TDD
 * red step. Contract under test (not yet implemented — implementer must
 * build apps/web/src/hooks/useFederationAuditLogQuery.ts AND add the
 * following new export to apps/web/src/lib/apiClient.ts):
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface FederationAuditEvent {
 *     id: string; streamId: string; streamType: string; workspaceId: string;
 *     type: 'FederatedContextAccessed' | 'FederatedContextRequested';
 *     version: number; payload: Record<string, unknown>;
 *     actor: { type: string; id: string }; occurredAt: string;
 *     globalPosition: number;
 *   }
 *   export function getFederationAuditLog(
 *     workspaceId: string, linkId: string,
 *   ): Promise<{ events: FederationAuditEvent[] }>;
 *
 *   // apps/web/src/hooks/useFederationAuditLogQuery.ts
 *   export function useFederationAuditLogQuery(
 *     workspaceId: string, linkId: string,
 *   ): UseQueryResult<{ events: FederationAuditEvent[] }>;
 *       // queryKey MUST be exactly ['federation-audit-log', workspaceId, linkId].
 *       // delegates to getFederationAuditLog(workspaceId, linkId). No RBAC gate
 *       // is enforced client-side here (ADR-0016 §a: read paths are never
 *       // role-gated beyond plain membership -- the server's
 *       // WorkspaceMembershipGuard is the only enforcement point).
 *
 * `./useFederationAuditLogQuery.ts` does not exist yet — see
 * `useFederationLinksQuery.test.ts`'s identical header comment for the
 * `ModuleExport as unknown as <shape>` lint-avoidance rationale, applied here
 * to this file's one hook function. apiClient.ts's new function is never
 * imported by name here either — `vi.mock` below supplies it via a
 * `vi.hoisted`-created mock.
 */

interface FederationAuditEvent {
  id: string;
  streamId: string;
  streamType: string;
  workspaceId: string;
  type: 'FederatedContextAccessed' | 'FederatedContextRequested';
  version: number;
  payload: Record<string, unknown>;
  actor: { type: string; id: string };
  occurredAt: string;
  globalPosition: number;
}

const { mockedGetFederationAuditLog } = vi.hoisted(() => {
  return { mockedGetFederationAuditLog: vi.fn() };
});

vi.mock('../lib/apiClient.js', () => ({
  getFederationAuditLog: mockedGetFederationAuditLog,
}));

const useFederationAuditLogQuery = useFederationAuditLogQueryModuleExport;

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

function makeAccessedEventFixture(
  overrides: Partial<FederationAuditEvent> = {},
): FederationAuditEvent {
  return {
    id: 'event-1',
    streamId: 'stream-1',
    streamType: 'federation-audit',
    workspaceId: 'ws-1',
    type: 'FederatedContextAccessed',
    version: 1,
    payload: {
      linkId: 'link-1',
      credentialId: 'cred-1',
      granteeWorkspaceId: 'ws-2',
      objectId: 'obj-1',
      occurredAt: '2026-09-01T00:00:00.000Z',
    },
    actor: { type: 'system', id: 'federation-audit-service' },
    occurredAt: '2026-09-01T00:00:00.000Z',
    globalPosition: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFederationAuditLogQuery', () => {
  const workspaceId = 'ws-1';
  const linkId = 'link-1';

  it('calls apiClient.getFederationAuditLog with the workspace id and linkId', async () => {
    const event = makeAccessedEventFixture();
    mockedGetFederationAuditLog.mockResolvedValueOnce({ events: [event] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationAuditLogQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGetFederationAuditLog).toHaveBeenCalledWith(workspaceId, linkId);
    expect(result.current.data).toEqual({ events: [event] });
  });

  it('exposes the exact ["federation-audit-log", workspaceId, linkId] query key', async () => {
    const event = makeAccessedEventFixture();
    mockedGetFederationAuditLog.mockResolvedValueOnce({ events: [event] });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationAuditLogQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData(['federation-audit-log', workspaceId, linkId]);
    expect(cached).toEqual({ events: [event] });
  });

  it('returns both FederatedContextAccessed and FederatedContextRequested events, undistinguished by the hook itself', async () => {
    const accessedEvent = makeAccessedEventFixture({ id: 'event-1' });
    const requestedEvent = makeAccessedEventFixture({
      id: 'event-2',
      type: 'FederatedContextRequested',
      workspaceId: 'ws-2',
      payload: {
        linkId: 'link-1',
        credentialId: 'cred-1',
        hostWorkspaceId: 'ws-1',
        objectId: 'obj-1',
        occurredAt: '2026-09-01T00:05:00.000Z',
      },
    });
    mockedGetFederationAuditLog.mockResolvedValueOnce({
      events: [accessedEvent, requestedEvent],
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationAuditLogQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.events).toHaveLength(2);
    expect(result.current.data?.events.map((event) => event.type)).toEqual([
      'FederatedContextAccessed',
      'FederatedContextRequested',
    ]);
  });

  it('transitions to isError with the thrown error when apiClient.getFederationAuditLog rejects', async () => {
    const error = new Error('boom');
    mockedGetFederationAuditLog.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFederationAuditLogQuery(workspaceId, linkId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});
