import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JSX } from 'react';

/**
 * RED-step test for ADR-0020-masaustu-sinyal-toplayicilar.md Karar (a) --
 * F2-T3 PR4. `apps/desktop/src/consent/ConsentSettings.tsx` does not exist
 * yet, and it depends on two OTHER new PR4 files
 * (`../api/http-client.ts`, `../workspace-context.ts`) that also don't
 * exist yet -- all three are `implementer`'s job to build together.
 *
 * Contract for `implementer`:
 *
 * - Exports a named `ConsentSettings` React component, no props -- reads
 *   the current workspace via `getWorkspaceId()` (`../workspace-context.ts`;
 *   real, UNMOCKED `localStorage` is used below -- set it directly rather
 *   than mocking that trivial module).
 * - On mount, calls `getDesktopSignalConsent(workspaceId, signalType)`
 *   (`../api/http-client.ts`) for BOTH `'calendar-status'` and
 *   `'active-window'` to determine each toggle's initial state (ON =
 *   consent non-null AND `revokedAt === null`; OFF = consent `null` OR
 *   `revokedAt` set).
 * - Renders one toggle per signal type, each discoverable via
 *   `screen.getByTestId('consent-toggle-calendar-status')` /
 *   `screen.getByTestId('consent-toggle-active-window')`, `role="switch"`,
 *   `aria-checked` reflecting the current state (`"true"`/`"false"`).
 * - Clicking a switch that is currently OFF calls
 *   `grantDesktopSignalConsent(workspaceId, signalType)`; clicking one that
 *   is currently ON calls `revokeDesktopSignalConsent(workspaceId,
 *   signalType)`. Once the call resolves, `aria-checked` reflects the new
 *   state (from the mutation's own response, or a re-fetch -- either way
 *   observable via `waitFor` below).
 *
 * Test strategy: same integration-across-the-real-seam approach as
 * `../signals/active-window-poller.test.ts` -- `fetch` is stubbed globally
 * and routed by URL/method, rather than `vi.mock`'ing `../api/http-client.ts`
 * (which does not exist on disk yet either).
 */

interface DesktopSignalConsentFixture {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * `./ConsentSettings.tsx` genuinely does not exist ANYWHERE on disk yet --
 * this dynamic import is EXPECTED to fail Vite's module-resolution at
 * collection time (reporting this file as "0 test" / a failed suite, not a
 * per-assertion failure) until `implementer` creates it (and its two
 * dependencies). That whole-suite-unresolved state IS this file's RED
 * signal.
 */
interface ConsentSettingsModuleLike {
  ConsentSettings: () => JSX.Element;
}

async function importConsentSettingsModule(): Promise<ConsentSettingsModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/consent/ConsentSettings.tsx does not exist yet.
  return (await import('./ConsentSettings')) as unknown as ConsentSettingsModuleLike;
}

const WORKSPACE_ID = 'ws-1';
const STORAGE_KEY = 'luminaos.workspaceId';

function grantedFixture(signalType: string): DesktopSignalConsentFixture {
  return { signalType, grantedAt: '2026-08-16T00:00:00.000Z', revokedAt: null };
}

function revokedFixture(signalType: string): DesktopSignalConsentFixture {
  return {
    signalType,
    grantedAt: '2026-08-16T00:00:00.000Z',
    revokedAt: '2026-08-16T01:00:00.000Z',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('<ConsentSettings /> (F2-T3 PR4, ADR-0020 Karar a)', () => {
  let consents: Record<string, DesktopSignalConsentFixture | null>;
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    localStorage.setItem(STORAGE_KEY, WORKSPACE_ID);
    consents = { 'calendar-status': null, 'active-window': null };

    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url, init) => {
      const method = init?.method ?? 'GET';

      if (url.includes('/context/desktop-signal-consents/calendar-status') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { consent: consents['calendar-status'] }));
      }
      if (url.includes('/context/desktop-signal-consents/active-window') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { consent: consents['active-window'] }));
      }
      if (url.endsWith('/context/desktop-signal-consents') && method === 'POST') {
        const body: unknown = JSON.parse((init?.body as string | undefined) ?? '{}');
        const signalType = (body as { signalType?: string }).signalType ?? 'unknown';
        consents[signalType] = grantedFixture(signalType);
        return Promise.resolve(jsonResponse(201, { consent: consents[signalType] }));
      }
      if (url.includes('/context/desktop-signal-consents/') && method === 'DELETE') {
        const signalType = url.split('/').pop() ?? 'unknown';
        consents[signalType] = revokedFixture(signalType);
        return Promise.resolve(jsonResponse(200, { consent: consents[signalType] }));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${method} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('shows each toggle in the state returned by getDesktopSignalConsent on mount', async () => {
    consents['active-window'] = grantedFixture('active-window');

    const { ConsentSettings } = await importConsentSettingsModule();
    render(<ConsentSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('consent-toggle-active-window')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
    expect(screen.getByTestId('consent-toggle-calendar-status')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('clicking an OFF toggle calls grantDesktopSignalConsent (POST) and flips it on', async () => {
    const { ConsentSettings } = await importConsentSettingsModule();
    render(<ConsentSettings />);

    const toggle = await screen.findByTestId('consent-toggle-calendar-status');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    const grantCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url.endsWith('/context/desktop-signal-consents') && (init?.method ?? 'GET') === 'POST',
    );
    expect(grantCall).toBeDefined();
    const [, init] = grantCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ signalType: 'calendar-status' });
  });

  it('clicking an ON toggle calls revokeDesktopSignalConsent (DELETE) and flips it off', async () => {
    consents['active-window'] = grantedFixture('active-window');

    const { ConsentSettings } = await importConsentSettingsModule();
    render(<ConsentSettings />);

    const toggle = await screen.findByTestId('consent-toggle-active-window');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

    const revokeCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url.includes('/context/desktop-signal-consents/active-window') &&
        (init?.method ?? 'GET') === 'DELETE',
    );
    expect(revokeCall).toBeDefined();
  });
});
