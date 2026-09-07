import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCommentsQuery, usePostCommentMutation } from './useCommentsQuery.js';
import { listComments, postComment } from '../lib/apiClient.js';

import type { Comment } from '../lib/apiClient.js';

/**
 * F3-T3 PR7a (ADR-0037 §c) — TDD red step. Contract under test (not yet
 * implemented — implementer must build apps/web/src/hooks/useCommentsQuery.ts
 * AND add the following new exports to apps/web/src/lib/apiClient.ts to
 * satisfy these tests; that's the expected TDD red state), mirroring
 * useProposalsQuery.ts/.test.ts's exact query-key/invalidation-by-prefix
 * shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface Comment {
 *     id: string; workspaceId: string; objectId: string;
 *     authorActor: { type: 'user' | 'agent'; id: string };
 *     body: string; mentionedAgentIds: string[]; createdAt: string;
 *   }
 *   export function listComments(
 *     workspaceId: string, objectId: string,
 *   ): Promise<{ comments: Comment[] }>;
 *     // GET /workspaces/:workspaceId/objects/:objectId/comments
 *   export function postComment(
 *     workspaceId: string, objectId: string, body: string,
 *   ): Promise<{ comment: Comment }>;
 *     // POST /workspaces/:workspaceId/objects/:objectId/comments, body: { body }
 *
 *   // apps/web/src/hooks/useCommentsQuery.ts
 *   export function useCommentsQuery(
 *     workspaceId: string, objectId: string,
 *   ): UseQueryResult<{ comments: Comment[] }>;
 *     // queryKey MUST be (or start with) ['comments', workspaceId, objectId].
 *   export function usePostCommentMutation(workspaceId: string, objectId: string):
 *     UseMutationResult<{ comment: Comment }, Error, string>;
 *       // mutationFn delegates to postComment(workspaceId, objectId, body).
 *       // onSuccess invalidates BY PREFIX ['comments', workspaceId, objectId]
 *       // queries (assert the invalidated queryKey STARTS WITH
 *       // ['comments', workspaceId, objectId], not that it equals it exactly).
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the two new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useMcpGrantsQuery.test.ts's identical rationale).
 * Real route/shape verified against
 * apps/server/src/comments/object-comments.controller.ts:
 * `@Controller('workspaces/:workspaceId/objects/:objectId/comments')` with
 * `@Post()`/`@Get()` handlers returning `{ comment: ObjectComment }` /
 * `{ comments: ObjectComment[] }` respectively, and
 * apps/server/src/comments/dto/create-comment.schema.ts's
 * `{ body: string }` request shape.
 */

vi.mock('../lib/apiClient.js', () => ({
  listComments: vi.fn(),
  postComment: vi.fn(),
}));

const mockedListComments = vi.mocked(listComments);
const mockedPostComment = vi.mocked(postComment);

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

function makeCommentFixture(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    workspaceId: 'ws-1',
    objectId: 'obj-1',
    authorActor: { type: 'user', id: 'user-1' },
    body: 'Merhaba @ReportBot',
    mentionedAgentIds: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCommentsQuery', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';

  it('calls apiClient.listComments with the workspace id and object id', async () => {
    const comment = makeCommentFixture();
    mockedListComments.mockResolvedValueOnce({ comments: [comment] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCommentsQuery(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListComments).toHaveBeenCalledWith(workspaceId, objectId);
    expect(result.current.data).toEqual({ comments: [comment] });
  });

  it('transitions to isError with the thrown error when apiClient.listComments rejects', async () => {
    const error = new Error('boom');
    mockedListComments.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCommentsQuery(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('usePostCommentMutation', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';
  const body = 'Merhaba @ReportBot, şu görevi kontrol eder misin?';

  it('calls apiClient.postComment with the workspace id, object id and body on mutate', async () => {
    const comment = makeCommentFixture({ body });
    mockedPostComment.mockResolvedValueOnce({ comment });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePostCommentMutation(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(body);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedPostComment).toHaveBeenCalledWith(workspaceId, objectId, body);
  });

  it('invalidates cached ["comments", workspaceId, objectId, ...] queries BY PREFIX once the mutation succeeds', async () => {
    const comment = makeCommentFixture({ body });
    mockedPostComment.mockResolvedValueOnce({ comment });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => usePostCommentMutation(workspaceId, objectId), {
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
    expect(invalidatedKey.slice(0, 3)).toEqual(['comments', workspaceId, objectId]);
  });

  it('resolves with the { comment } shape returned by apiClient.postComment', async () => {
    const comment = makeCommentFixture({ id: 'comment-new', body });
    mockedPostComment.mockResolvedValueOnce({ comment });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePostCommentMutation(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(body);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ comment });
  });
});
