import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RED-step test for ADR-0020-masaustu-sinyal-toplayicilar.md (F2-T3 PR4) --
 * `apps/desktop/src/api/http-client.ts` does not exist yet.
 *
 * Contract for `implementer`:
 *
 * - `const SERVER_BASE_URL = import.meta.env['VITE_SERVER_URL'] ??
 *   'http://localhost:3000'` (matches `apps/server/src/main.ts`'s
 *   `app.listen(3000)` default -- this is the SERVER's port, distinct from
 *   ADR-0019's `tauri.conf.json` `devUrl` port 1420, which is the DESKTOP
 *   dev-server's own port).
 * - An internal `request<T>(path, init)` helper mirroring `apps/web/src/
 *   lib/apiClient.ts`'s `request<T>()` EXACTLY (`credentials: 'include'`,
 *   `Content-Type: application/json` header, `ApiError`/`isServerErrorBody`
 *   error-conversion shape) except it builds an ABSOLUTE url
 *   (`${SERVER_BASE_URL}${path}`) instead of a relative one -- the desktop
 *   webview has no same-origin dev proxy to the server the way `apps/web`'s
 *   Vite config does.
 * - An exported `ApiError` class: `new ApiError(message, code, statusCode)`,
 *   readable `.message`/`.code`/`.statusCode`, thrown/rejected whenever the
 *   server responds non-ok with a `{error: {code, message}}` body.
 * - `grantDesktopSignalConsent(workspaceId, signalType)`: `POST
 *   /workspaces/:workspaceId/context/desktop-signal-consents`, body
 *   `{signalType}`, unwraps the server's `{consent}` envelope and returns
 *   the bare consent object.
 * - `revokeDesktopSignalConsent(workspaceId, signalType)`: `DELETE
 *   /workspaces/:workspaceId/context/desktop-signal-consents/:signalType`,
 *   same unwrapping.
 * - `getDesktopSignalConsent(workspaceId, signalType)`: `GET` the same
 *   signalType-scoped URL, unwraps `{consent}`, returns `null` when the
 *   server returns `{consent: null}`.
 * - `captureDesktopSignal(workspaceId, signalType, value)`: `POST
 *   /workspaces/:workspaceId/context/desktop-signals`, body
 *   `{signalType, value}`, resolves `void` on success (callers don't need
 *   the `{captured: true}` envelope).
 * - `listCalendarEvents(workspaceId, range)`: `GET
 *   /workspaces/:workspaceId/calendar/events?start=...&end=...` (same
 *   `URLSearchParams` convention as `apiClient.ts`'s
 *   `listExternalCalendarEvents`), unwraps `{events}`, returns the bare
 *   array.
 * - ALL five functions ALWAYS send `credentials: 'include'` -- the desktop
 *   webview carries the SAME httpOnly session-cookie mechanism as
 *   `apps/web` once a session exists (see `apps/desktop/README.md`'s
 *   manual smoke-test steps for how a session/workspaceId get into a dev
 *   webview; F2-T3b is the real login-UI follow-up).
 */

interface DesktopSignalConsentLike {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface CachedCalendarEventLike {
  externalId: string;
  title: string;
  start: string;
  end: string;
}

interface ApiErrorLike extends Error {
  code: string;
  statusCode: number;
}

/**
 * `./http-client.ts` doesn't exist yet -- same `*Like` escape hatch as
 * `../signals/active-window.test.ts`'s `ActiveWindowModuleLike`/
 * `importActiveWindowModule` (a genuinely-unresolved dynamic import
 * type-checks as `any` under this repo's `projectService` ESLint setup,
 * so this cast is the only thing standing between every call site and an
 * `any` cascade -- it resolves itself automatically the moment
 * `implementer` creates `http-client.ts`).
 */
interface HttpClientModuleLike {
  ApiError: new (message: string, code: string, statusCode: number) => ApiErrorLike;
  grantDesktopSignalConsent: (
    workspaceId: string,
    signalType: string,
  ) => Promise<DesktopSignalConsentLike>;
  revokeDesktopSignalConsent: (
    workspaceId: string,
    signalType: string,
  ) => Promise<DesktopSignalConsentLike>;
  getDesktopSignalConsent: (
    workspaceId: string,
    signalType: string,
  ) => Promise<DesktopSignalConsentLike | null>;
  captureDesktopSignal: (workspaceId: string, signalType: string, value: string) => Promise<void>;
  listCalendarEvents: (
    workspaceId: string,
    range: { start: string; end: string },
  ) => Promise<CachedCalendarEventLike[]>;
}

async function importHttpClientModule(): Promise<HttpClientModuleLike> {
  // `./http-client.ts` genuinely does not exist ANYWHERE on disk yet
  // (unlike `../signals/active-window.test.ts`'s target module, already
  // built in PR3) -- this dynamic import is EXPECTED to fail Vite's
  // module-resolution at collection time (reporting this file as "0 test"
  // / a failed suite, not a per-assertion failure) until `implementer`
  // creates the file. That whole-suite-unresolved state IS this file's RED
  // signal; the moment `http-client.ts` exists, collection succeeds and
  // every `it()` below starts asserting for real.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/api/http-client.ts does not exist yet.
  return (await import('./http-client')) as unknown as HttpClientModuleLike;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('apps/desktop http-client (F2-T3 PR4, ADR-0020)', () => {
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('grantDesktopSignalConsent POSTs to the absolute consents URL with credentials:include and unwraps {consent}', async () => {
    const consent: DesktopSignalConsentLike = {
      signalType: 'active-window',
      grantedAt: '2026-08-16T00:00:00.000Z',
      revokedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { consent }));

    const { grantDesktopSignalConsent } = await importHttpClientModule();
    const result = await grantDesktopSignalConsent('ws-1', 'active-window');

    expect(result).toEqual(consent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/workspaces/ws-1/context/desktop-signal-consents');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({ signalType: 'active-window' });
  });

  it('revokeDesktopSignalConsent DELETEs to the signalType-scoped URL with credentials:include', async () => {
    const consent: DesktopSignalConsentLike = {
      signalType: 'active-window',
      grantedAt: '2026-08-16T00:00:00.000Z',
      revokedAt: '2026-08-16T01:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { consent }));

    const { revokeDesktopSignalConsent } = await importHttpClientModule();
    const result = await revokeDesktopSignalConsent('ws-1', 'active-window');

    expect(result).toEqual(consent);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3000/workspaces/ws-1/context/desktop-signal-consents/active-window',
    );
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('include');
  });

  it('getDesktopSignalConsent GETs the signalType-scoped URL and returns null when unset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { consent: null }));

    const { getDesktopSignalConsent } = await importHttpClientModule();
    const result = await getDesktopSignalConsent('ws-1', 'calendar-status');

    expect(result).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3000/workspaces/ws-1/context/desktop-signal-consents/calendar-status',
    );
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
  });

  it('captureDesktopSignal POSTs {signalType, value} to the desktop-signals URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { captured: true }));

    const { captureDesktopSignal } = await importHttpClientModule();
    await captureDesktopSignal('ws-1', 'active-window', 'Code.exe');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/workspaces/ws-1/context/desktop-signals');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({
      signalType: 'active-window',
      value: 'Code.exe',
    });
  });

  it('listCalendarEvents GETs the calendar events URL with start/end query params and unwraps {events}', async () => {
    const events: CachedCalendarEventLike[] = [
      {
        externalId: 'ext-1',
        title: 'Ignored title',
        start: '2026-08-16T11:45:00.000Z',
        end: '2026-08-16T12:15:00.000Z',
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { events }));

    const { listCalendarEvents } = await importHttpClientModule();
    const range = { start: '2026-08-16T11:45:00.000Z', end: '2026-08-16T12:15:00.000Z' };
    const result = await listCalendarEvents('ws-1', range);

    expect(result).toEqual(events);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expectedQuery = new URLSearchParams(range).toString();
    expect(url).toBe(`http://localhost:3000/workspaces/ws-1/calendar/events?${expectedQuery}`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
  });

  it('converts a non-ok server error body into a rejected ApiError with matching code/message/statusCode', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Rıza verilmemiş' } }),
    );

    const { captureDesktopSignal } = await importHttpClientModule();

    await expect(captureDesktopSignal('ws-1', 'active-window', 'Code.exe')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Rıza verilmemiş',
      statusCode: 403,
    });
  });

  it('the rejected error is an instance of the exported ApiError class', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Rıza verilmemiş' } }),
    );

    const { captureDesktopSignal, ApiError } = await importHttpClientModule();

    await expect(captureDesktopSignal('ws-1', 'active-window', 'Code.exe')).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
