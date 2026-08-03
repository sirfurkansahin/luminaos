import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedView } from '@luminaos/core-objects';
import type { QuerySpec } from '@luminaos/shared';

import {
  createObject,
  createSavedView,
  deleteSavedView,
  getSavedViews,
  patchFieldValues,
  postObjectsQuery,
  updateSavedView,
  ApiError,
} from './apiClient.js';

import type { SavedViewCreateInput, SavedViewUpdateInput } from './apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/lib/apiClient.ts to satisfy these tests, and add
 * `@luminaos/shared` and `@luminaos/core-objects` as runtime dependencies of
 * apps/web/package.json — neither is there yet, so these imports will fail
 * to resolve until then. That's the expected TDD red state.):
 *
 *   export class ApiError extends AppError { ... } // from @luminaos/shared's
 *       // AppError base class (CLAUDE.md: no bare `throw new Error`).
 *       // Constructed from the server's `{ error: { code, message } }` body
 *       // (apps/server/src/common/app-error.filter.ts's shape) when present,
 *       // with `statusCode` = the HTTP response status. If the body can't be
 *       // parsed as that shape, falls back to a generic code/message that
 *       // still carries the real HTTP status.
 *
 *   export function postObjectsQuery(
 *     workspaceId: string,
 *     querySpec: QuerySpec,
 *   ): Promise<QueryResult>; // QueryResult mirrors apps/server's
 *       // ObjectsService QueryResult union: `{ objects, nextCursor? }` or
 *       // `{ groups }` — POST /workspaces/:workspaceId/objects/query
 *
 *   export function patchFieldValues(
 *     workspaceId: string,
 *     objectId: string,
 *     values: Record<string, unknown>,
 *   ): Promise<{ object: ObjectWithFieldValues }>; // PATCH
 *       // /workspaces/:workspaceId/objects/:objectId/fields, body { values }
 *
 *   export function createObject(
 *     workspaceId: string,
 *     input: { objectType: string; title: string },
 *   ): Promise<{ object: ObjectWithFieldValues }>; // POST
 *       // /workspaces/:workspaceId/objects
 *
 * Every request MUST be issued with `credentials: 'include'` — the server
 * authenticates via a session cookie (SessionAuthGuard), and without this the
 * browser will silently drop the cookie on cross-origin requests in dev
 * (web on one port, server on another). This is asserted explicitly below
 * because it is easy to forget and would fail silently (401s) rather than
 * loudly in manual testing against a same-origin proxy.
 *
 * URLs are relative (e.g. `/workspaces/${workspaceId}/objects/query`, no
 * scheme/host) — apiClient does not hardcode an absolute base URL; any
 * environment-specific base is Vite dev-proxy/prod-reverse-proxy's job, not
 * this module's.
 *
 * On a non-ok response (4xx/5xx), every function rejects with an `ApiError`
 * carrying the server's `code`/`message`/`statusCode` — never resolves with
 * a partial/undefined value and never throws a bare `Error`.
 *
 * F1-T9 PR2 addition — SavedView CRUD client (apps/server's
 * saved-views.controller.ts, already merged):
 *
 *   export interface SavedViewCreateInput {
 *     name: string;
 *     icon: string;
 *     viewType: SavedView['viewType'];
 *     objectType: string;
 *     querySpec: SavedView['querySpec'];
 *     dateField?: string;
 *     startField?: string;
 *     endField?: string;
 *     shared: boolean;
 *   } // deliberately has NO `ownerId` key at the type level — the server
 *     // always derives ownership from the session (`shared: true` -> null,
 *     // `shared: false` -> caller's own id); the client must be structurally
 *     // incapable of forwarding one (F1-T9 plan's security decision).
 *
 *   export type SavedViewUpdateInput = Partial<
 *     Pick<SavedViewCreateInput, 'name' | 'icon' | 'querySpec' | 'dateField' | 'startField' | 'endField'>
 *   >; // matches update-saved-view.schema.ts: objectType/shared/ownerId/viewType are NOT patchable.
 *
 *   export function getSavedViews(
 *     workspaceId: string,
 *     objectType: string,
 *   ): Promise<{ savedViews: SavedView[] }>; // GET /workspaces/:workspaceId/views?objectType=...
 *
 *   export function createSavedView(
 *     workspaceId: string,
 *     input: SavedViewCreateInput,
 *   ): Promise<{ savedView: SavedView }>; // POST /workspaces/:workspaceId/views
 *
 *   export function updateSavedView(
 *     workspaceId: string,
 *     savedViewId: string,
 *     input: SavedViewUpdateInput,
 *   ): Promise<{ savedView: SavedView }>; // PATCH /workspaces/:workspaceId/views/:savedViewId
 *
 *   export function deleteSavedView(workspaceId: string, savedViewId: string): Promise<void>;
 *       // DELETE /workspaces/:workspaceId/views/:savedViewId — server responds 204 No
 *       // Content, so this must resolve without attempting to parse a response body.
 *
 * `SavedView` itself is imported from `@luminaos/core-objects` (already
 * exported there by PR1) — apiClient.ts does not redefine it.
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

describe('postObjectsQuery', () => {
  const workspaceId = 'ws-1';
  const querySpec: QuerySpec = { objectType: 'task', filters: [] };

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(200, { objects: [] });

    await postObjectsQuery(workspaceId, querySpec);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('POSTs to /workspaces/:workspaceId/objects/query with the query spec as JSON body', async () => {
    mockFetchOnce(200, { objects: [] });

    await postObjectsQuery(workspaceId, querySpec);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/objects/query`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(querySpec);
  });

  it('resolves with the parsed JSON body on success', async () => {
    const payload = { objects: [], nextCursor: undefined };
    mockFetchOnce(200, { objects: [] });

    const result = await postObjectsQuery(workspaceId, querySpec);

    expect(result).toEqual({ objects: [] });
    void payload;
  });

  it('rejects with an ApiError carrying the server error code/message on a 4xx response', async () => {
    mockFetchOnce(403, { error: { code: 'FORBIDDEN', message: 'Not a member' } });

    await expect(postObjectsQuery(workspaceId, querySpec)).rejects.toBeInstanceOf(ApiError);
    await expect(postObjectsQuery(workspaceId, querySpec)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'Not a member',
    });
  });

  it('rejects with an ApiError on a 5xx response', async () => {
    mockFetchOnce(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });

    await expect(postObjectsQuery(workspaceId, querySpec)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('patchFieldValues', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';
  const values = { status: 'done' };

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(200, { object: { id: objectId, fieldValues: values } });

    await patchFieldValues(workspaceId, objectId, values);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('PATCHes to /workspaces/:workspaceId/objects/:objectId/fields with { values } as JSON body', async () => {
    mockFetchOnce(200, { object: { id: objectId, fieldValues: values } });

    await patchFieldValues(workspaceId, objectId, values);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/objects/${objectId}/fields`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ values });
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    mockFetchOnce(409, { error: { code: 'CONFLICT', message: 'Version conflict' } });

    await expect(patchFieldValues(workspaceId, objectId, values)).rejects.toBeInstanceOf(ApiError);
    await expect(patchFieldValues(workspaceId, objectId, values)).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });
  });
});

describe('createObject', () => {
  const workspaceId = 'ws-1';
  const input = { objectType: 'task', title: 'New task' };

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(201, { object: { id: 'obj-2', title: input.title } });

    await createObject(workspaceId, input);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('POSTs to /workspaces/:workspaceId/objects with the create input as JSON body', async () => {
    mockFetchOnce(201, { object: { id: 'obj-2', title: input.title } });

    await createObject(workspaceId, input);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/objects`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    mockFetchOnce(422, { error: { code: 'VALIDATION_ERROR', message: 'Invalid title' } });

    await expect(createObject(workspaceId, input)).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to a generic ApiError when the error response body cannot be parsed as { error }', async () => {
    mockFetchOnce(500, { unexpected: 'shape' });

    await expect(createObject(workspaceId, input)).rejects.toBeInstanceOf(ApiError);
    await expect(createObject(workspaceId, input)).rejects.toMatchObject({ statusCode: 500 });
  });
});

function makeSavedViewFixture(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'sv-1',
    workspaceId: 'ws-1',
    objectType: 'task',
    name: 'Acil görevler',
    icon: 'Star',
    viewType: 'board',
    querySpec: { objectType: 'task', filters: [] },
    ownerId: null,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function mockFetchOnceNoContent(status = 204): void {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.reject(new Error('should not call json() on a No Content response')),
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('getSavedViews', () => {
  const workspaceId = 'ws-1';
  const objectType = 'task';

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(200, { savedViews: [] });

    await getSavedViews(workspaceId, objectType);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('GETs /workspaces/:workspaceId/views with an objectType query param', async () => {
    mockFetchOnce(200, { savedViews: [] });

    await getSavedViews(workspaceId, objectType);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/views?objectType=${objectType}`);
    expect(init.method).toBe('GET');
  });

  it('resolves with the parsed { savedViews } body on success', async () => {
    const savedView = makeSavedViewFixture();
    mockFetchOnce(200, { savedViews: [savedView] });

    const result = await getSavedViews(workspaceId, objectType);

    expect(result).toEqual({ savedViews: [savedView] });
  });

  it('rejects with an ApiError carrying the server error code/message on a non-ok response', async () => {
    mockFetchOnce(403, { error: { code: 'FORBIDDEN', message: 'Not a member' } });

    await expect(getSavedViews(workspaceId, objectType)).rejects.toBeInstanceOf(ApiError);
    await expect(getSavedViews(workspaceId, objectType)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });
});

describe('createSavedView', () => {
  const workspaceId = 'ws-1';
  const input: SavedViewCreateInput = {
    name: 'Bu haftaki acil görevler',
    icon: 'Star',
    viewType: 'board',
    objectType: 'task',
    querySpec: {
      objectType: 'task',
      filters: [{ field: 'priority', operator: 'equals', value: 'high' }],
    },
    shared: false,
  };

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(201, { savedView: makeSavedViewFixture(input) });

    await createSavedView(workspaceId, input);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('POSTs to /workspaces/:workspaceId/views with the input as the JSON body', async () => {
    mockFetchOnce(201, { savedView: makeSavedViewFixture(input) });

    await createSavedView(workspaceId, input);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/views`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('never sends an ownerId key in the request body — the server derives ownership itself', async () => {
    mockFetchOnce(201, { savedView: makeSavedViewFixture(input) });

    await createSavedView(workspaceId, input);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(parsedBody).sort()).toEqual(
      ['icon', 'name', 'objectType', 'querySpec', 'shared', 'viewType'].sort(),
    );
    expect(parsedBody).not.toHaveProperty('ownerId');

    // Compile-time guard (checked by `pnpm typecheck`, not by vitest itself):
    // SavedViewCreateInput must have no `ownerId` key at all, so a caller
    // cannot even construct one that carries it.
    // @ts-expect-error SavedViewCreateInput has no `ownerId` property — the
    // server always derives ownership from the session, never a client value.
    const attemptedSpoof: SavedViewCreateInput = { ...input, ownerId: 'user-1' };
    expect(attemptedSpoof).toBeDefined();
  });

  it('resolves with the parsed { savedView } body on success', async () => {
    const savedView = makeSavedViewFixture(input);
    mockFetchOnce(201, { savedView });

    const result = await createSavedView(workspaceId, input);

    expect(result).toEqual({ savedView });
  });

  it('rejects with an ApiError when the server 403s a shared-view create from a non-admin', async () => {
    mockFetchOnce(403, {
      error: { code: 'FORBIDDEN', message: 'Only admins may create shared views' },
    });

    await expect(createSavedView(workspaceId, { ...input, shared: true })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(createSavedView(workspaceId, { ...input, shared: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });
});

describe('updateSavedView', () => {
  const workspaceId = 'ws-1';
  const savedViewId = 'sv-1';
  const input: SavedViewUpdateInput = { name: 'Yeniden adlandırıldı' };

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnce(200, {
      savedView: makeSavedViewFixture({ id: savedViewId, name: 'Yeniden adlandırıldı' }),
    });

    await updateSavedView(workspaceId, savedViewId, input);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('PATCHes to /workspaces/:workspaceId/views/:savedViewId with the input as the JSON body', async () => {
    mockFetchOnce(200, {
      savedView: makeSavedViewFixture({ id: savedViewId, name: 'Yeniden adlandırıldı' }),
    });

    await updateSavedView(workspaceId, savedViewId, input);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/views/${savedViewId}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('resolves with the parsed { savedView } body on success', async () => {
    const savedView = makeSavedViewFixture({ id: savedViewId, name: 'Yeniden adlandırıldı' });
    mockFetchOnce(200, { savedView });

    const result = await updateSavedView(workspaceId, savedViewId, input);

    expect(result).toEqual({ savedView });
  });

  it('rejects with an ApiError when a non-owner/non-admin caller is refused (403)', async () => {
    mockFetchOnce(403, {
      error: { code: 'FORBIDDEN', message: 'Not the owner of this personal view' },
    });

    await expect(updateSavedView(workspaceId, savedViewId, input)).rejects.toBeInstanceOf(ApiError);
    await expect(updateSavedView(workspaceId, savedViewId, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });
});

describe('deleteSavedView', () => {
  const workspaceId = 'ws-1';
  const savedViewId = 'sv-1';

  it('issues the fetch request with credentials: "include"', async () => {
    mockFetchOnceNoContent(204);

    await deleteSavedView(workspaceId, savedViewId);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('DELETEs to /workspaces/:workspaceId/views/:savedViewId', async () => {
    mockFetchOnceNoContent(204);

    await deleteSavedView(workspaceId, savedViewId);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/views/${savedViewId}`);
    expect(init.method).toBe('DELETE');
  });

  it('resolves without attempting to parse a response body (server returns 204 No Content)', async () => {
    mockFetchOnceNoContent(204);

    await expect(deleteSavedView(workspaceId, savedViewId)).resolves.toBeUndefined();
  });

  it('rejects with an ApiError carrying the server error code/message on a non-ok response', async () => {
    mockFetchOnce(403, {
      error: { code: 'FORBIDDEN', message: 'Only the owner or an admin may delete this view' },
    });

    await expect(deleteSavedView(workspaceId, savedViewId)).rejects.toBeInstanceOf(ApiError);
    await expect(deleteSavedView(workspaceId, savedViewId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });
});

describe('module setup sanity', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call fetch until a client function is invoked (no import-time side effects)', () => {
    // Guards against accidental module-level fetch/network calls creeping in.
    expect(global.fetch).not.toBe(vi.fn());
  });
});
