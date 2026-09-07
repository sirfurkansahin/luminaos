import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDmMessagesQuery, useSendDmMessageMutation } from './useDmMessagesQuery.js';
import { listDmMessages, sendDmMessage } from '../lib/apiClient.js';

import type { DmMessage } from '../lib/apiClient.js';

/**
 * F3-T3 PR7b (ADR-0037 §d) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/hooks/useDmMessagesQuery.ts AND add the following new exports
 * to apps/web/src/lib/apiClient.ts to satisfy these tests; that's the
 * expected TDD red state), mirroring useCommentsQuery.ts/.test.ts's exact
 * query-key/invalidation-by-prefix shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface DmMessage {
 *     id: string; workspaceId: string; userId: string;
 *     agentIdentifier: string; sender: 'user' | 'agent'; body: string;
 *     proposalId: string | null; createdAt: string;
 *   }
 *   export function listDmMessages(
 *     workspaceId: string, agentIdentifier: string,
 *   ): Promise<{ messages: DmMessage[] }>;
 *     // GET /workspaces/:workspaceId/agents/:agentIdentifier/dm
 *   export function sendDmMessage(
 *     workspaceId: string, agentIdentifier: string, body: string,
 *   ): Promise<{ userMessage: DmMessage; agentReply: DmMessage }>;
 *     // POST /workspaces/:workspaceId/agents/:agentIdentifier/dm, body: { body }
 *
 *   // apps/web/src/hooks/useDmMessagesQuery.ts
 *   export function useDmMessagesQuery(
 *     workspaceId: string, agentIdentifier: string,
 *   ): UseQueryResult<{ messages: DmMessage[] }>;
 *     // queryKey MUST be (or start with) ['dm-messages', workspaceId, agentIdentifier].
 *   export function useSendDmMessageMutation(workspaceId: string, agentIdentifier: string):
 *     UseMutationResult<{ userMessage: DmMessage; agentReply: DmMessage }, Error, string>;
 *       // mutationFn delegates to sendDmMessage(workspaceId, agentIdentifier, body).
 *       // onSuccess invalidates BY PREFIX ['dm-messages', workspaceId, agentIdentifier]
 *       // queries (assert the invalidated queryKey STARTS WITH
 *       // ['dm-messages', workspaceId, agentIdentifier], not that it equals it exactly).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the two new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useCommentsQuery.test.ts's identical rationale).
 * Real route/shape verified against
 * apps/server/src/direct-messages/direct-messages.controller.ts:
 * `@Controller('workspaces/:workspaceId/agents/:agentIdentifier/dm')` with
 * `@Post()`/`@Get()` handlers returning `{ userMessage, agentReply }` /
 * `{ messages }` respectively.
 */

vi.mock('../lib/apiClient.js', () => ({
  listDmMessages: vi.fn(),
  sendDmMessage: vi.fn(),
}));

const mockedListDmMessages = vi.mocked(listDmMessages);
const mockedSendDmMessage = vi.mocked(sendDmMessage);

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

function makeDmMessageFixture(overrides: Partial<DmMessage> = {}): DmMessage {
  return {
    id: 'dm-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    agentIdentifier: 'report-bot@luminaos.internal',
    sender: 'user',
    body: 'Merhaba ReportBot',
    proposalId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDmMessagesQuery', () => {
  const workspaceId = 'ws-1';
  const agentIdentifier = 'report-bot@luminaos.internal';

  it('calls apiClient.listDmMessages with the workspace id and agent identifier', async () => {
    const message = makeDmMessageFixture();
    mockedListDmMessages.mockResolvedValueOnce({ messages: [message] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDmMessagesQuery(workspaceId, agentIdentifier), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListDmMessages).toHaveBeenCalledWith(workspaceId, agentIdentifier);
    expect(result.current.data).toEqual({ messages: [message] });
  });

  it('transitions to isError with the thrown error when apiClient.listDmMessages rejects', async () => {
    const error = new Error('boom');
    mockedListDmMessages.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDmMessagesQuery(workspaceId, agentIdentifier), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useSendDmMessageMutation', () => {
  const workspaceId = 'ws-1';
  const agentIdentifier = 'report-bot@luminaos.internal';
  const body = 'ReportBot, şu görevi kontrol eder misin?';

  it('calls apiClient.sendDmMessage with the workspace id, agent identifier and body on mutate', async () => {
    const userMessage = makeDmMessageFixture({ id: 'dm-1', body, sender: 'user' });
    const agentReply = makeDmMessageFixture({ id: 'dm-2', body: 'Tamamdır', sender: 'agent' });
    mockedSendDmMessage.mockResolvedValueOnce({ userMessage, agentReply });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSendDmMessageMutation(workspaceId, agentIdentifier), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(body);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedSendDmMessage).toHaveBeenCalledWith(workspaceId, agentIdentifier, body);
  });

  it('invalidates cached ["dm-messages", workspaceId, agentIdentifier, ...] queries BY PREFIX once the mutation succeeds', async () => {
    const userMessage = makeDmMessageFixture({ id: 'dm-1', body, sender: 'user' });
    const agentReply = makeDmMessageFixture({ id: 'dm-2', body: 'Tamamdır', sender: 'agent' });
    mockedSendDmMessage.mockResolvedValueOnce({ userMessage, agentReply });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSendDmMessageMutation(workspaceId, agentIdentifier), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(body);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    const invalidatedKey = filters?.queryKey ?? [];
    expect(invalidatedKey.slice(0, 3)).toEqual(['dm-messages', workspaceId, agentIdentifier]);
  });

  it('resolves with the { userMessage, agentReply } shape returned by apiClient.sendDmMessage', async () => {
    const userMessage = makeDmMessageFixture({ id: 'dm-new-1', body, sender: 'user' });
    const agentReply = makeDmMessageFixture({
      id: 'dm-new-2',
      body: 'Anlaşıldı, kontrol ediyorum.',
      sender: 'agent',
    });
    mockedSendDmMessage.mockResolvedValueOnce({ userMessage, agentReply });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSendDmMessageMutation(workspaceId, agentIdentifier), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(body);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ userMessage, agentReply });
  });
});
