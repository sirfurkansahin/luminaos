import { afterEach, describe, expect, it, vi } from 'vitest';

import { listCalendarConflicts, listExternalCalendarEvents } from './apiClient.js';

import type { ConflictPair, ExternalCalendarEvent } from './apiClient.js';

/**
 * F1-T12 PR8a — TDD red step. Contract under test (not yet implemented —
 * implementer must add these two exports to apps/web/src/lib/apiClient.ts):
 *
 *   export interface ExternalCalendarEvent {
 *     externalId: string;
 *     title: string;
 *     start: string;
 *     end: string;
 *   }
 *
 *   export interface ConflictInterval {
 *     kind: 'timeblock' | 'external';
 *     id: string;
 *     title: string;
 *     start: string;
 *     end: string;
 *   }
 *
 *   export interface ConflictPair { a: ConflictInterval; b: ConflictInterval; }
 *
 *   export function listExternalCalendarEvents(
 *     workspaceId: string,
 *     range: { start: string; end: string },
 *   ): Promise<ExternalCalendarEvent[]>;
 *       // GET /workspaces/:workspaceId/calendar/events?start=&end=
 *       // unwraps { events: ExternalCalendarEvent[] } to just the array.
 *
 *   export function listCalendarConflicts(
 *     workspaceId: string,
 *     range: { start: string; end: string },
 *   ): Promise<ConflictPair[]>;
 *       // GET /workspaces/:workspaceId/calendar/conflicts?start=&end=
 *       // unwraps { conflicts: ConflictPair[] } to just the array.
 *
 * Both mirror apiClient.ts's existing `request<T>()`-based style (`GET`,
 * `credentials: 'include'` via the shared helper, `ApiError` on non-ok
 * responses) — asserted via apiClient.test.ts's own suites for every other
 * function already, so this file only pins the two NEW functions'
 * URL/query-param/unwrap behavior, not the whole request() plumbing again.
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

describe('listExternalCalendarEvents', () => {
  const workspaceId = 'ws-1';
  const range = { start: '2026-08-01', end: '2026-08-31' };

  it('GETs /workspaces/:workspaceId/calendar/events with start/end query params', async () => {
    mockFetchOnce(200, { events: [] });

    await listExternalCalendarEvents(workspaceId, range);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/workspaces/${workspaceId}/calendar/events?start=${range.start}&end=${range.end}`,
    );
    expect(init.method).toBe('GET');
  });

  it('unwraps { events: [...] } to the bare ExternalCalendarEvent[] array', async () => {
    const event: ExternalCalendarEvent = {
      externalId: 'ext-1',
      title: 'Doktor randevusu',
      start: '2026-08-05T10:00:00.000Z',
      end: '2026-08-05T10:30:00.000Z',
    };
    mockFetchOnce(200, { events: [event] });

    const result = await listExternalCalendarEvents(workspaceId, range);

    expect(result).toEqual([event]);
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(403, { error: { code: 'FORBIDDEN', message: 'Not a member' } });

    await expect(listExternalCalendarEvents(workspaceId, range)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('listCalendarConflicts', () => {
  const workspaceId = 'ws-1';
  const range = { start: '2026-08-01', end: '2026-08-31' };

  it('GETs /workspaces/:workspaceId/calendar/conflicts with start/end query params', async () => {
    mockFetchOnce(200, { conflicts: [] });

    await listCalendarConflicts(workspaceId, range);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/workspaces/${workspaceId}/calendar/conflicts?start=${range.start}&end=${range.end}`,
    );
    expect(init.method).toBe('GET');
  });

  it('unwraps { conflicts: [...] } to the bare ConflictPair[] array', async () => {
    const pair: ConflictPair = {
      a: {
        kind: 'timeblock',
        id: 'obj-1',
        title: 'Odak bloğu',
        start: '2026-08-05T09:00:00.000Z',
        end: '2026-08-05T11:00:00.000Z',
      },
      b: {
        kind: 'external',
        id: 'ext-1',
        title: 'Doktor randevusu',
        start: '2026-08-05T10:00:00.000Z',
        end: '2026-08-05T10:30:00.000Z',
      },
    };
    mockFetchOnce(200, { conflicts: [pair] });

    const result = await listCalendarConflicts(workspaceId, range);

    expect(result).toEqual([pair]);
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });

    await expect(listCalendarConflicts(workspaceId, range)).rejects.toBeInstanceOf(ApiError);
  });
});
