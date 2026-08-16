import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RED-step test for ADR-0020-masaustu-sinyal-toplayicilar.md Karar (c)
 * (debounce-on-change) + Karar (e) (yerinde işleme sınırı, KRİTİK) --
 * F2-T3 PR4. `apps/desktop/src/signals/calendar-status-poller.ts` does not
 * exist yet.
 *
 * Contract for `implementer`:
 *
 * - Exports `createCalendarStatusPoller(intervalMs: number): { start: () =>
 *   void; stop: () => void }`.
 * - On each tick: reads `getWorkspaceId()` (`../workspace-context.ts`) --
 *   `null` is a no-op; reads consent via `getDesktopSignalConsent(
 *   workspaceId, 'calendar-status')` (`../api/http-client.ts`) -- same
 *   stop-on-revoke/no-consent gate as `active-window-poller.ts`; calls
 *   `listCalendarEvents(workspaceId, {start, end})` for a narrow range
 *   covering "now"; derives `'busy'` if ANY returned event's `[start, end)`
 *   interval contains "now", else `'free'`.
 * - **KRİTİK (ADR Karar e):** the derived `value` passed to
 *   `captureDesktopSignal(workspaceId, 'calendar-status', value)` is
 *   ALWAYS the string `'busy'` or `'free'` -- `event.title`/any other event
 *   field NEVER appears in the captured value, even though the events
 *   returned by `listCalendarEvents` carry a `title` field (same
 *   `CachedCalendarEvent` shape as `apps/server`'s
 *   `calendar-events.service.ts`).
 * - Debounce-on-change: only calls `captureDesktopSignal` when the derived
 *   status DIFFERS from the last-sent one (same closure-state discipline as
 *   `active-window-poller.ts`).
 *
 * Test strategy: same integration-across-the-real-seam approach as
 * `./active-window-poller.test.ts` -- `fetch` is stubbed globally and
 * routed by URL/method (consent GET, calendar-events GET, signal-capture
 * POST), rather than `vi.mock`'ing `../api/http-client.ts` (which does not
 * exist on disk yet either).
 */

interface PollerHandle {
  start: () => void;
  stop: () => void;
}

/**
 * `./calendar-status-poller.ts` genuinely does not exist ANYWHERE on disk
 * yet -- this dynamic import is EXPECTED to fail Vite's module-resolution
 * at collection time (reporting this file as "0 test" / a failed suite,
 * not a per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal.
 */
interface CalendarStatusPollerModuleLike {
  createCalendarStatusPoller: (intervalMs: number) => PollerHandle;
}

async function importPollerModule(): Promise<CalendarStatusPollerModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/signals/calendar-status-poller.ts does not exist yet.
  return (await import('./calendar-status-poller')) as unknown as CalendarStatusPollerModuleLike;
}

interface CachedCalendarEventFixture {
  externalId: string;
  title: string;
  start: string;
  end: string;
}

interface ConsentFixture {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

const WORKSPACE_ID = 'ws-1';
const STORAGE_KEY = 'luminaos.workspaceId';
const INTERVAL_MS = 1000;
const NOW = '2026-08-16T12:00:00.000Z';

const SENSITIVE_TITLE = 'Gizli Görüşme - Maaş Zammı';

const BUSY_EVENT: CachedCalendarEventFixture = {
  externalId: 'ext-1',
  title: SENSITIVE_TITLE,
  start: '2026-08-16T11:45:00.000Z',
  end: '2026-08-16T12:15:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('createCalendarStatusPoller (F2-T3 PR4, ADR-0020 Karar c/e)', () => {
  let consentFixture: ConsentFixture | null;
  let eventsFixture: CachedCalendarEventFixture[];
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    localStorage.setItem(STORAGE_KEY, WORKSPACE_ID);
    consentFixture = {
      signalType: 'calendar-status',
      grantedAt: '2026-08-16T00:00:00.000Z',
      revokedAt: null,
    };
    eventsFixture = [];

    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/context/desktop-signal-consents/') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { consent: consentFixture }));
      }
      if (url.includes('/calendar/events') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { events: eventsFixture }));
      }
      if (url.includes('/context/desktop-signals') && method === 'POST') {
        return Promise.resolve(jsonResponse(201, { captured: true }));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${method} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
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

  it('an event overlapping "now" derives value "busy" -- and NEVER leaks the event title into the captured value', async () => {
    eventsFixture = [BUSY_EVENT];

    const { createCalendarStatusPoller } = await importPollerModule();
    const poller = createCalendarStatusPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const calls = captureCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as [string, RequestInit];
    const body: unknown = JSON.parse(init.body as string);
    expect(body).toEqual({ signalType: 'calendar-status', value: 'busy' });

    // The whole raw request body, not just `.value` -- proves the sensitive
    // title never leaks into ANY field of the captured payload.
    expect(init.body as string).not.toContain(SENSITIVE_TITLE);
    expect(init.body as string).not.toContain('Maaş');

    poller.stop();
  });

  it('no overlapping event derives value "free"', async () => {
    eventsFixture = [];

    const { createCalendarStatusPoller } = await importPollerModule();
    const poller = createCalendarStatusPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const calls = captureCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      signalType: 'calendar-status',
      value: 'free',
    });

    poller.stop();
  });

  it('an unchanged busy/free status across ticks produces exactly ONE capture call (debounce-on-change)', async () => {
    eventsFixture = [BUSY_EVENT];

    const { createCalendarStatusPoller } = await importPollerModule();
    const poller = createCalendarStatusPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(captureCalls()).toHaveLength(1);

    poller.stop();
  });

  it('a status change (busy -> free) produces a second capture call', async () => {
    eventsFixture = [BUSY_EVENT];

    const { createCalendarStatusPoller } = await importPollerModule();
    const poller = createCalendarStatusPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    eventsFixture = [];
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const calls = captureCalls();
    expect(calls).toHaveLength(2);
    const [, secondInit] = calls[1] as [string, RequestInit];
    expect(JSON.parse(secondInit.body as string)).toEqual({
      signalType: 'calendar-status',
      value: 'free',
    });

    poller.stop();
  });

  it('a REVOKED consent never captures, even with an overlapping event present', async () => {
    consentFixture = {
      signalType: 'calendar-status',
      grantedAt: '2026-08-16T00:00:00.000Z',
      revokedAt: '2026-08-16T01:00:00.000Z',
    };
    eventsFixture = [BUSY_EVENT];

    const { createCalendarStatusPoller } = await importPollerModule();
    const poller = createCalendarStatusPoller(INTERVAL_MS);
    poller.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(captureCalls()).toHaveLength(0);

    poller.stop();
  });
});
