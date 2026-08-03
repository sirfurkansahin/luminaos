import { describe, expect, it } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { computeCalendarQuerySpec, computeVisibleRange } from './calendarQuery.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/calendar/calendarQuery.ts to satisfy these tests.
 * That's the expected TDD red state.):
 *
 *   export function computeVisibleRange(gridDays: Date[]): { start: string; end: string };
 *       // `start`/`end` are the ISO 'YYYY-MM-DD' dates (via
 *       // apps/web/src/lib/dateMath.ts's `toISODate`) of the first and last
 *       // entries of `gridDays` respectively — i.e. the full padded grid
 *       // range (including adjacent-month overflow days), not just the
 *       // anchor month itself.
 *
 *   export function computeCalendarQuerySpec(
 *     objectType: string,
 *     dateField: string | undefined,
 *     range: { start: string; end: string } | undefined,
 *   ): QuerySpec;
 *       // When both `dateField` and `range` are defined, returns
 *       // `{ objectType, filters: [{ field: dateField, operator: 'between',
 *       // value: [range.start, range.end] }] }`. When either is
 *       // `undefined` (bootstrap phase, before a date field has been
 *       // detected/selected, or before the grid has been computed), returns
 *       // the unfiltered bootstrap shape `{ objectType, filters: [] }`.
 */

describe('computeVisibleRange', () => {
  it("returns the first grid day's ISO date as start and the last as end", () => {
    const gridDays = [
      new Date(Date.UTC(2026, 6, 27)),
      new Date(Date.UTC(2026, 6, 28)),
      new Date(Date.UTC(2026, 6, 29)),
      new Date(Date.UTC(2026, 6, 30)),
      new Date(Date.UTC(2026, 6, 31)),
      new Date(Date.UTC(2026, 7, 1)),
    ];

    expect(computeVisibleRange(gridDays)).toEqual({ start: '2026-07-27', end: '2026-08-01' });
  });

  it('handles a single-day grid where start and end coincide', () => {
    const gridDays = [new Date(Date.UTC(2026, 7, 3))];

    expect(computeVisibleRange(gridDays)).toEqual({ start: '2026-08-03', end: '2026-08-03' });
  });

  it('handles a full 42-day month grid range', () => {
    const gridDays = Array.from(
      { length: 42 },
      (_, i) => new Date(Date.UTC(2026, 7, 3) + i * 86_400_000),
    );

    expect(computeVisibleRange(gridDays)).toEqual({ start: '2026-08-03', end: '2026-09-13' });
  });
});

describe('computeCalendarQuerySpec', () => {
  it('returns a between-filter query spec when both dateField and range are defined', () => {
    const result: QuerySpec = computeCalendarQuerySpec('task', 'dueDate', {
      start: '2026-08-01',
      end: '2026-08-31',
    });

    expect(result).toEqual({
      objectType: 'task',
      filters: [{ field: 'dueDate', operator: 'between', value: ['2026-08-01', '2026-08-31'] }],
    });
  });

  it('returns the unfiltered bootstrap shape when dateField is undefined', () => {
    const result = computeCalendarQuerySpec('task', undefined, {
      start: '2026-08-01',
      end: '2026-08-31',
    });

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('returns the unfiltered bootstrap shape when range is undefined', () => {
    const result = computeCalendarQuerySpec('task', 'dueDate', undefined);

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('returns the unfiltered bootstrap shape when both dateField and range are undefined', () => {
    const result = computeCalendarQuerySpec('task', undefined, undefined);

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('preserves the given objectType in every case', () => {
    const withFilter = computeCalendarQuerySpec('event', 'startDate', {
      start: '2026-01-01',
      end: '2026-01-31',
    });
    const bootstrap = computeCalendarQuerySpec('event', undefined, undefined);

    expect(withFilter.objectType).toBe('event');
    expect(bootstrap.objectType).toBe('event');
  });
});
