import { describe, expect, it } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { computeTimelineQuerySpec } from './timelineQuery.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/timeline/timelineQuery.ts to satisfy these tests.
 * That's the expected TDD red state.):
 *
 *   export function computeTimelineQuerySpec(
 *     objectType: string,
 *     startField: string | undefined,
 *     endField: string | undefined,
 *     range: { start: string; end: string } | undefined,
 *   ): QuerySpec;
 *
 * When `startField`, `endField`, and `range` are all defined, this expresses
 * a true date-range OVERLAP query (object.start <= range.end AND
 * object.end >= range.start) using only the `before`/`after` operators
 * `DATE_OPERATORS` actually allows for date/datetime fields (no `gte`/`lte`),
 * padded by ±1 day so the strict comparison becomes inclusive at the day
 * granularity:
 *
 *   {
 *     objectType,
 *     filters: [
 *       { field: startField, operator: 'before', value: toISODate(addDays(parseISODate(range.end), 1)) },
 *       { field: endField, operator: 'after', value: toISODate(addDays(parseISODate(range.start), -1)) },
 *     ],
 *   }
 *
 * The padded boundary values must be computed via
 * apps/web/src/lib/dateMath.ts's `addDays`/`toISODate`/`parseISODate` (already
 * implemented) — not hand-rolled date-string arithmetic in the new module.
 *
 * When any of `startField`/`endField`/`range` is `undefined` (bootstrap phase,
 * before both date fields have been detected/selected, or before the visible
 * window has been computed), returns the unfiltered bootstrap shape
 * `{ objectType, filters: [] }`.
 */

describe('computeTimelineQuerySpec', () => {
  it('returns an overlap query (before/after, ±1 day padded) when startField, endField, and range are all defined', () => {
    const result: QuerySpec = computeTimelineQuerySpec('task', 'startDate', 'endDate', {
      start: '2026-03-10',
      end: '2026-03-20',
    });

    expect(result).toEqual({
      objectType: 'task',
      filters: [
        { field: 'startDate', operator: 'before', value: '2026-03-21' },
        { field: 'endDate', operator: 'after', value: '2026-03-09' },
      ],
    });
  });

  it('returns the unfiltered bootstrap shape when startField is undefined', () => {
    const result = computeTimelineQuerySpec('task', undefined, 'endDate', {
      start: '2026-03-10',
      end: '2026-03-20',
    });

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('returns the unfiltered bootstrap shape when endField is undefined', () => {
    const result = computeTimelineQuerySpec('task', 'startDate', undefined, {
      start: '2026-03-10',
      end: '2026-03-20',
    });

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('returns the unfiltered bootstrap shape when range is undefined', () => {
    const result = computeTimelineQuerySpec('task', 'startDate', 'endDate', undefined);

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('returns the unfiltered bootstrap shape when startField, endField, and range are all undefined', () => {
    const result = computeTimelineQuerySpec('task', undefined, undefined, undefined);

    expect(result).toEqual({ objectType: 'task', filters: [] });
  });

  it('rolls the "before" boundary over into the next month when range.end is the last day of a month', () => {
    const result = computeTimelineQuerySpec('task', 'startDate', 'endDate', {
      start: '2026-01-15',
      end: '2026-01-31',
    });

    expect(result).toEqual({
      objectType: 'task',
      filters: [
        { field: 'startDate', operator: 'before', value: '2026-02-01' },
        { field: 'endDate', operator: 'after', value: '2026-01-14' },
      ],
    });
  });

  it('rolls the "after" boundary back into the previous month when range.start is the first day of a month', () => {
    // 2026 is not a leap year -- February has 28 days, so one day before
    // 2026-03-01 must correctly land on 2026-02-28 (exercises addDays'
    // backward month-rollover, not just forward).
    const result = computeTimelineQuerySpec('task', 'startDate', 'endDate', {
      start: '2026-03-01',
      end: '2026-03-15',
    });

    expect(result).toEqual({
      objectType: 'task',
      filters: [
        { field: 'startDate', operator: 'before', value: '2026-03-16' },
        { field: 'endDate', operator: 'after', value: '2026-02-28' },
      ],
    });
  });

  it('preserves the given objectType in every case', () => {
    const withFilters = computeTimelineQuerySpec('event', 'startDate', 'endDate', {
      start: '2026-01-01',
      end: '2026-01-31',
    });
    const bootstrap = computeTimelineQuerySpec('event', undefined, undefined, undefined);

    expect(withFilters.objectType).toBe('event');
    expect(bootstrap.objectType).toBe('event');
  });
});
