import { afterEach, describe, expect, it, vi } from 'vitest';

import { explainDeviation } from './apiClient.js';

/**
 * F3-T11 PR3 (sapma açıklama kartı, frontend yarısı, ADR-0045 Karar e/g,
 * spec Kapsam madde 7 + Kabul Kriterleri) — TDD red step. Contract under
 * test (`explainDeviation` does not exist in apps/web/src/lib/apiClient.ts
 * yet — implementer must add it):
 *
 *   export function explainDeviation(
 *     workspaceId: string,
 *     baselineObjectId: string,
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // POST /workspaces/:workspaceId/artifacts/baselines/:baselineObjectId/explain
 *       // NO request body (ADR-0045 Karar e: "Request body YOK" — the id URL
 *       // parameter plus the baseline's own already-stored querySpec/
 *       // aggregateFn/capturedValue/targetFieldKey are entirely sufficient
 *       // server-side).
 *       // Mirrors `captureBaseline`/`generateWidget`'s exact
 *       // `request<T>()`-based call shape (this file's own established
 *       // convention: dedicated apiClient.<feature>.test.ts split files pin
 *       // ONE function's URL/method/body/resolve/reject behavior each,
 *       // reusing the shared `request()` plumbing already covered by
 *       // apiClient.test.ts's `postObjectsQuery`/`patchFieldValues`
 *       // describe blocks — not re-asserted here).
 *
 * `apps/server`'s already-merged F3-T11 PR2 route
 * (`apps/server/src/artifacts/baselines.controller.ts`'s
 * `POST :id/explain`) is the real contract this pins client-side.
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

describe('explainDeviation', () => {
  const workspaceId = 'ws-1';
  const baselineObjectId = 'baseline-1';

  function makeBaselineObjectFixture(): unknown {
    return {
      id: baselineObjectId,
      workspaceId,
      type: 'artifact',
      title: 'Aktif Görev Sayısı',
      fieldValues: {
        artifactType: 'baseline',
        querySpec: JSON.stringify({ objectType: 'task', filters: [] }),
        aggregateFn: 'count',
        capturedValue: 10,
        explanationSummary: 'Bu ay tamamlanan görev sayısı belirgin şekilde arttı.',
        explanationCauses: JSON.stringify(['Ekip büyüdü', 'Süreç iyileştirildi']),
        explanationGeneratedAt: '2026-09-12T00:00:00.000Z',
      },
    };
  }

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(200, { object: makeBaselineObjectFixture() });

    await explainDeviation(workspaceId, baselineObjectId);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('POSTs to /workspaces/:workspaceId/artifacts/baselines/:baselineObjectId/explain with NO request body', async () => {
    mockFetchOnce(200, { object: makeBaselineObjectFixture() });

    await explainDeviation(workspaceId, baselineObjectId);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/workspaces/${encodeURIComponent(workspaceId)}/artifacts/baselines/${encodeURIComponent(baselineObjectId)}/explain`,
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('encodeURIComponent-encodes both the workspaceId and the baselineObjectId in the URL', async () => {
    mockFetchOnce(200, { object: makeBaselineObjectFixture() });
    const workspaceIdWithSpecialChars = 'ws/1 space';
    const baselineObjectIdWithSpecialChars = 'baseline/1 space';

    await explainDeviation(workspaceIdWithSpecialChars, baselineObjectIdWithSpecialChars);

    const [url] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/workspaces/${encodeURIComponent(workspaceIdWithSpecialChars)}/artifacts/baselines/${encodeURIComponent(baselineObjectIdWithSpecialChars)}/explain`,
    );
  });

  it('resolves with the parsed { object } body exactly as returned, including the new explanation fields', async () => {
    const object = makeBaselineObjectFixture();
    mockFetchOnce(200, { object });

    const result = await explainDeviation(workspaceId, baselineObjectId);

    expect(result).toEqual({ object });
  });

  it('rejects with an ApiError carrying the server error code/message on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(422, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Current aggregate value could not be computed for this baseline.',
      },
    });

    await expect(explainDeviation(workspaceId, baselineObjectId)).rejects.toBeInstanceOf(ApiError);
    await expect(explainDeviation(workspaceId, baselineObjectId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
    });
  });
});
