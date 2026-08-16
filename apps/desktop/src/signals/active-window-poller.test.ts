import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RED-step test for ADR-0020-masaustu-sinyal-toplayicilar.md Karar (c)
 * (debounce-on-change, KRİTİK) + client-side consent gate -- F2-T3 PR4.
 * `apps/desktop/src/signals/active-window-poller.ts` does not exist yet.
 *
 * Contract for `implementer`:
 *
 * - Exports `createActiveWindowPoller(intervalMs: number): { start: () =>
 *   void; stop: () => void }`.
 * - `start()` begins a `setInterval(..., intervalMs)` loop. On each tick:
 *   1. Reads `getWorkspaceId()` (`../workspace-context.ts`) -- if `null`,
 *      the tick is a no-op.
 *   2. Reads consent via `getDesktopSignalConsent(workspaceId,
 *      'active-window')` (`../api/http-client.ts`) -- if the consent is
 *      missing, has no `grantedAt`, or has a non-null `revokedAt`, polling
 *      STOPS (the underlying `setInterval` is cleared) and NO signal is
 *      ever captured, this tick or any future one.
 *   3. Otherwise calls `getActiveWindowAppName()` (`./active-window.ts`,
 *      already built in PR3) and compares the result against the
 *      LAST-SENT value (closure/module-instance state, not React state --
 *      this poller is a plain, independently-testable unit). Only when the
 *      value DIFFERS from the last-sent one does it call
 *      `captureDesktopSignal(workspaceId, 'active-window', value)`
 *      (`../api/http-client.ts`) and update the last-sent value.
 * - `stop()` clears the interval; no further ticks fire.
 *
 * Test strategy (ADR-0020 §(i)(a)): `getActiveWindowAppName()`'s underlying
 * `invoke()` call is faked via `@tauri-apps/api/mocks`'s `mockIPC` against
 * the REAL, already-built `./active-window.ts` -- no module mock needed for
 * it. `../api/http-client.ts`'s HTTP calls (consent GET, signal-capture
 * POST) are exercised for real too, but the underlying `fetch` is stubbed
 * globally and asserted on by URL/method. This is DELIBERATELY an
 * integration-across-the-real-seam test (poller -> http-client -> fetch),
 * not a poller-vs-mocked-http-client unit test -- it stays valid regardless
 * of exactly how `http-client.ts`'s functions are implemented internally,
 * and avoids `vi.mock`'ing a sibling module (`../api/http-client.ts`) that
 * does not exist on disk yet either.
 */

interface PollerHandle {
  start: () => void;
  stop: () => void;
}

/**
 * `./active-window-poller.ts` genuinely does not exist ANYWHERE on disk
 * yet -- this dynamic import is EXPECTED to fail Vite's module-resolution
 * at collection time (reporting this file as "0 test" / a failed suite,
 * not a per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal; the moment
 * `active-window-poller.ts` (and its `../api/http-client.ts` /
 * `../workspace-context.ts` dependencies) exist, collection succeeds and
 * every `it()` below starts asserting for real.
 */
interface ActiveWindowPollerModuleLike {
  createActiveWindowPoller: (intervalMs: number) => PollerHandle;
}

async function importPollerModule(): Promise<ActiveWindowPollerModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/signals/active-window-poller.ts does not exist yet.
  return (await import('./active-window-poller')) as unknown as ActiveWindowPollerModuleLike;
}

const WORKSPACE_ID = 'ws-1';
const STORAGE_KEY = 'luminaos.workspaceId';
const INTERVAL_MS = 1000;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface ConsentFixture {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

describe('createActiveWindowPoller (F2-T3 PR4, ADR-0020 Karar c)', () => {
  let consentFixture: ConsentFixture | null;
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, WORKSPACE_ID);
    consentFixture = {
      signalType: 'active-window',
      grantedAt: '2026-08-16T00:00:00.000Z',
      revokedAt: null,
    };

    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/context/desktop-signal-consents/') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { consent: consentFixture }));
      }
      if (url.includes('/context/desktop-signals') && method === 'POST') {
        return Promise.resolve(jsonResponse(201, { captured: true }));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${method} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  function captureCalls(): typeof fetchMock.mock.calls {
    return fetchMock.mock.calls.filter(
      ([url, init]) =>
        url.includes('/context/desktop-signals') && (init?.method ?? 'GET') === 'POST',
    );
  }

  it('the SAME polled value across many ticks produces exactly ONE capture call (debounce-on-change)', async () => {
    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        return 'Code.exe';
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    const { createActiveWindowPoller } = await importPollerModule();
    const poller = createActiveWindowPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const calls = captureCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      signalType: 'active-window',
      value: 'Code.exe',
    });

    poller.stop();
  });

  it('a CHANGED polled value produces a second capture call with the new value', async () => {
    const responses = ['Code.exe', 'Code.exe', 'firefox.exe', 'firefox.exe'];
    let callIndex = 0;
    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        const value = responses[Math.min(callIndex, responses.length - 1)] ?? 'unreachable.exe';
        callIndex += 1;
        return value;
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    const { createActiveWindowPoller } = await importPollerModule();
    const poller = createActiveWindowPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const calls = captureCalls();
    expect(calls).toHaveLength(2);
    const [, firstInit] = calls[0] as [string, RequestInit];
    const [, secondInit] = calls[1] as [string, RequestInit];
    expect(JSON.parse(firstInit.body as string)).toEqual({
      signalType: 'active-window',
      value: 'Code.exe',
    });
    expect(JSON.parse(secondInit.body as string)).toEqual({
      signalType: 'active-window',
      value: 'firefox.exe',
    });

    poller.stop();
  });

  it('a REVOKED consent (revokedAt set) never captures, even across many ticks', async () => {
    consentFixture = {
      signalType: 'active-window',
      grantedAt: '2026-08-16T00:00:00.000Z',
      revokedAt: '2026-08-16T01:00:00.000Z',
    };
    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        return 'Code.exe';
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    const { createActiveWindowPoller } = await importPollerModule();
    const poller = createActiveWindowPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(captureCalls()).toHaveLength(0);

    poller.stop();
  });

  it('NO consent at all (never granted) never captures', async () => {
    consentFixture = null;
    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        return 'Code.exe';
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    const { createActiveWindowPoller } = await importPollerModule();
    const poller = createActiveWindowPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(captureCalls()).toHaveLength(0);

    poller.stop();
  });

  it('stop() halts further capturing even when the polled value keeps changing', async () => {
    const responses = ['a.exe', 'b.exe', 'c.exe', 'd.exe'];
    let callIndex = 0;
    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        const value = responses[Math.min(callIndex, responses.length - 1)] ?? 'unreachable.exe';
        callIndex += 1;
        return value;
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    const { createActiveWindowPoller } = await importPollerModule();
    const poller = createActiveWindowPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    const callsAfterFirstTick = captureCalls().length;
    poller.stop();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(captureCalls()).toHaveLength(callsAfterFirstTick);
  });
});
