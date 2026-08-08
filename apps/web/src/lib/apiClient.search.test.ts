import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchWorkspace } from './apiClient.js';

import type { SearchResult } from './apiClient.js';

/**
 * F1-T13 PR6 (ADR-0013) — TDD red step. Contract under test (not yet
 * implemented — implementer must add these exports to
 * apps/web/src/lib/apiClient.ts):
 *
 *   export interface SearchResult {
 *     objectId: string;
 *     title: string;
 *     type: string;
 *     score: number;
 *   }
 *
 *   export function searchWorkspace(
 *     workspaceId: string,
 *     query: string,
 *     limit?: number,
 *   ): Promise<{ results: SearchResult[] }>;
 *       // POST /workspaces/:workspaceId/search
 *       // body = { query, ...(limit !== undefined ? { limit } : {}) }
 *       //   (mirrors setAvailability's existing "omit key entirely when
 *       //   undefined" convention in this same file)
 *       // mirrors apiClient.ts's existing request<T>()-based style (JSON
 *       // body, credentials: 'include' via the shared helper, ApiError on
 *       // non-ok responses) — this file only pins THIS function's
 *       // URL/method/body/resolve/reject behavior, not the whole request()
 *       // plumbing again (already covered by sibling apiClient.*.test.ts
 *       // files for other functions).
 *
 * Matches the REAL server contract already merged in F1-T13 PR5:
 * apps/server/src/search/search.controller.ts +
 * apps/server/src/search/dto/search-workspace.schema.ts +
 * apps/server/src/search/search.service.ts's SearchResult shape.
 */

function mockFetchOnce(status: number, body: unknown, ok = status >= 200 && status < 300): void {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
}

function getFetchMock(): ReturnType<typeof vi.fn> {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('searchWorkspace', () => {
  const workspaceId = 'ws-1';

  it('POSTs to /workspaces/:workspaceId/search with { query } and no limit key when limit is omitted', async () => {
    mockFetchOnce(200, { results: [] });

    await searchWorkspace(workspaceId, 'roadmap');

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/search`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const parsedBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsedBody).toEqual({ query: 'roadmap' });
    expect('limit' in parsedBody).toBe(false);
  });

  it('includes limit in the body when provided', async () => {
    mockFetchOnce(200, { results: [] });

    await searchWorkspace(workspaceId, 'roadmap', 5);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ query: 'roadmap', limit: 5 });
  });

  it('resolves with the parsed { results } body exactly as returned', async () => {
    const results: SearchResult[] = [
      { objectId: 'obj-1', title: 'Q3 Roadmap', type: 'task', score: 0.92 },
      { objectId: 'obj-2', title: 'Roadmap review notes', type: 'note', score: 0.51 },
    ];
    mockFetchOnce(200, { results });

    const result = await searchWorkspace(workspaceId, 'roadmap');

    expect(result).toEqual({ results });
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(400, { error: { code: 'BAD_REQUEST', message: 'Query too long' } });

    await expect(searchWorkspace(workspaceId, 'roadmap')).rejects.toBeInstanceOf(ApiError);
  });
});
