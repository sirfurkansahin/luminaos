import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAvailability, scheduleTimeBlock, setAvailability } from './apiClient.js';

import type { AvailabilitySnapshot, TimeBlockSchedule } from './apiClient.js';

/**
 * F1-T12 PR8b — TDD red step. Contract under test (not yet implemented —
 * implementer must add these exports to apps/web/src/lib/apiClient.ts):
 *
 *   export interface TimeBlockSchedule { start: string; end: string; }
 *
 *   export function scheduleTimeBlock(
 *     workspaceId: string,
 *     objectId: string,
 *     schedule: TimeBlockSchedule,
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // POST /workspaces/:workspaceId/objects/:objectId/timeblock, body = schedule
 *
 *   export function clearTimeBlockSchedule(
 *     workspaceId: string,
 *     objectId: string,
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *       // DELETE /workspaces/:workspaceId/objects/:objectId/timeblock
 *
 *   export type AvailabilityStatus = 'available' | 'focus' | 'ooo';
 *   export interface AvailabilitySnapshot {
 *     status: AvailabilityStatus;
 *     until?: string;
 *     updatedAt: string;
 *   }
 *
 *   export function getAvailability(
 *     workspaceId: string,
 *   ): Promise<AvailabilitySnapshot | null>;
 *       // GET /workspaces/:workspaceId/availability
 *       // unwraps { availability: AvailabilitySnapshot | null }
 *
 *   export function setAvailability(
 *     workspaceId: string,
 *     status: AvailabilityStatus,
 *     until?: string,
 *   ): Promise<AvailabilitySnapshot>;
 *       // PUT /workspaces/:workspaceId/availability
 *       // body = { status, ...(until !== undefined ? { until } : {}) }
 *       // unwraps { availability: AvailabilitySnapshot }
 *
 * All four mirror apiClient.ts's existing `request<T>()`-based style (JSON
 * body, `credentials: 'include'` via the shared helper, `ApiError` on
 * non-ok responses) — asserted via apiClient.test.ts's own suites for every
 * other function already, so this file only pins these NEW functions'
 * URL/method/body/unwrap behavior, not the whole request() plumbing again.
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

describe('scheduleTimeBlock', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';
  const schedule: TimeBlockSchedule = {
    start: '2026-08-05T09:00:00.000Z',
    end: '2026-08-05T10:00:00.000Z',
  };

  it('POSTs to /workspaces/:workspaceId/objects/:objectId/timeblock with the schedule as body', async () => {
    mockFetchOnce(200, { object: { id: objectId } });

    await scheduleTimeBlock(workspaceId, objectId, schedule);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/objects/${objectId}/timeblock`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(schedule);
  });

  it('resolves with the unwrapped { object } response', async () => {
    mockFetchOnce(200, { object: { id: objectId, title: 'Odak bloğu' } });

    const result = await scheduleTimeBlock(workspaceId, objectId, schedule);

    expect(result).toEqual({ object: { id: objectId, title: 'Odak bloğu' } });
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(409, { error: { code: 'CONFLICT', message: 'Overlaps another block' } });

    await expect(scheduleTimeBlock(workspaceId, objectId, schedule)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('clearTimeBlockSchedule', () => {
  const workspaceId = 'ws-1';
  const objectId = 'obj-1';

  it('DELETEs /workspaces/:workspaceId/objects/:objectId/timeblock', async () => {
    const { clearTimeBlockSchedule } = await import('./apiClient.js');
    mockFetchOnce(200, { object: { id: objectId } });

    await clearTimeBlockSchedule(workspaceId, objectId);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/objects/${objectId}/timeblock`);
    expect(init.method).toBe('DELETE');
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError, clearTimeBlockSchedule } = await import('./apiClient.js');
    mockFetchOnce(404, { error: { code: 'NOT_FOUND', message: 'No object' } });

    await expect(clearTimeBlockSchedule(workspaceId, objectId)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getAvailability', () => {
  const workspaceId = 'ws-1';

  it('GETs /workspaces/:workspaceId/availability', async () => {
    mockFetchOnce(200, { availability: null });

    await getAvailability(workspaceId);

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/availability`);
    expect(init.method).toBe('GET');
  });

  it('unwraps { availability: AvailabilitySnapshot } to the bare snapshot', async () => {
    const snapshot: AvailabilitySnapshot = {
      status: 'focus',
      until: '2026-08-05T12:00:00.000Z',
      updatedAt: '2026-08-05T09:00:00.000Z',
    };
    mockFetchOnce(200, { availability: snapshot });

    const result = await getAvailability(workspaceId);

    expect(result).toEqual(snapshot);
  });

  it('unwraps { availability: null } to null (never-set case)', async () => {
    mockFetchOnce(200, { availability: null });

    const result = await getAvailability(workspaceId);

    expect(result).toBeNull();
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });

    await expect(getAvailability(workspaceId)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('setAvailability', () => {
  const workspaceId = 'ws-1';

  it('PUTs /workspaces/:workspaceId/availability with { status } when until is omitted', async () => {
    mockFetchOnce(200, {
      availability: { status: 'ooo', updatedAt: '2026-08-05T09:00:00.000Z' },
    });

    await setAvailability(workspaceId, 'ooo');

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspaces/${workspaceId}/availability`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'ooo' });
  });

  it('PUTs { status, until } when until is provided', async () => {
    mockFetchOnce(200, {
      availability: {
        status: 'focus',
        until: '2026-08-05T12:00:00.000Z',
        updatedAt: '2026-08-05T09:00:00.000Z',
      },
    });

    await setAvailability(workspaceId, 'focus', '2026-08-05T12:00:00.000Z');

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      status: 'focus',
      until: '2026-08-05T12:00:00.000Z',
    });
  });

  it('resolves with the unwrapped AvailabilitySnapshot', async () => {
    const snapshot: AvailabilitySnapshot = {
      status: 'available',
      updatedAt: '2026-08-05T09:00:00.000Z',
    };
    mockFetchOnce(200, { availability: snapshot });

    const result = await setAvailability(workspaceId, 'available');

    expect(result).toEqual(snapshot);
  });

  it('rejects with an ApiError on a non-ok response', async () => {
    const { ApiError } = await import('./apiClient.js');
    mockFetchOnce(400, { error: { code: 'BAD_REQUEST', message: 'Invalid status' } });

    await expect(setAvailability(workspaceId, 'available')).rejects.toBeInstanceOf(ApiError);
  });
});
