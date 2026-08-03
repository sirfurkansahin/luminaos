import { describe, expect, it } from 'vitest';

import { computeBarLayout, type TimelineBar } from './timelineLayout.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/timeline/timelineLayout.ts to satisfy these tests.
 * That's the expected TDD red state.):
 *
 *   export interface TimelineBar {
 *     objectId: string;
 *     left: number;
 *     width: number;
 *     clampedStart: boolean;
 *     clampedEnd: boolean;
 *   }
 *
 *   export function computeBarLayout(
 *     objects: Array<{ id: string; fieldValues: Record<string, unknown> }>,
 *     startField: string,
 *     endField: string,
 *     range: { start: string; end: string },
 *     pxPerDay: number,
 *   ): TimelineBar[];
 *
 * For each object, `left`/`width` are derived from day-offsets of the
 * object's start/end dates within `range` (via
 * apps/web/src/lib/dateMath.ts's `parseISODate`/`toISODate`/`addDays`), then
 * scaled by `pxPerDay`. When the object's actual start/end falls outside the
 * visible `range`, the day-offset is clamped to `[0, totalRangeDays]` and the
 * corresponding `clampedStart`/`clampedEnd` flag is set to `true`.
 *
 * Objects whose `fieldValues[startField]` or `fieldValues[endField]` is
 * missing or not a valid `YYYY-MM-DD`-prefixed date-like string are excluded
 * entirely from the returned array (skipped, not included with some
 * fallback/zeroed layout).
 */

describe('computeBarLayout', () => {
  const range = { start: '2026-03-01', end: '2026-03-31' };
  const pxPerDay = 10;

  it('lays out a bar fully inside the visible range with exact left/width in px', () => {
    const result = computeBarLayout(
      [{ id: 'obj-1', fieldValues: { start: '2026-03-05', end: '2026-03-10' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    // start offset = 4 days from range.start (03-01 -> 03-05) => left = 40px
    // end offset = 9 days from range.start (03-01 -> 03-10) => width = (9 - 4) * 10 = 50px
    expect(result).toEqual<TimelineBar[]>([
      { objectId: 'obj-1', left: 40, width: 50, clampedStart: false, clampedEnd: false },
    ]);
  });

  it('clamps the left edge when the object starts before the visible range', () => {
    const result = computeBarLayout(
      [{ id: 'obj-2', fieldValues: { start: '2026-02-20', end: '2026-03-05' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    // start is before range.start -> clamped to offset 0 (left = 0px, clampedStart: true)
    // end offset = 4 days from range.start (03-01 -> 03-05) => width = 4 * 10 = 40px
    expect(result).toEqual<TimelineBar[]>([
      { objectId: 'obj-2', left: 0, width: 40, clampedStart: true, clampedEnd: false },
    ]);
  });

  it('clamps the right edge when the object ends after the visible range', () => {
    const result = computeBarLayout(
      [{ id: 'obj-3', fieldValues: { start: '2026-03-25', end: '2026-04-15' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    // start offset = 24 days from range.start (03-01 -> 03-25) => left = 240px
    // end is after range.end -> clamped to the total range span, 30 days
    // (03-01 -> 03-31 inclusive is a 30-day offset) => width = (30 - 24) * 10 = 60px
    expect(result).toEqual<TimelineBar[]>([
      { objectId: 'obj-3', left: 240, width: 60, clampedStart: false, clampedEnd: true },
    ]);
  });

  it('spans the entire visible range, clamped on both edges', () => {
    const result = computeBarLayout(
      [{ id: 'obj-4', fieldValues: { start: '2026-01-01', end: '2026-06-30' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    // both edges clamped: left = 0px, width = totalRangeDays (30) * 10 = 300px
    expect(result).toEqual<TimelineBar[]>([
      { objectId: 'obj-4', left: 0, width: 300, clampedStart: true, clampedEnd: true },
    ]);
  });

  it('gives a zero-length (single-day) bar a sane minimum width, not 0px', () => {
    const result = computeBarLayout(
      [{ id: 'obj-5', fieldValues: { start: '2026-03-10', end: '2026-03-10' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    // start === end -> the bar still represents one visible day of width,
    // i.e. exactly one day's worth of px (pxPerDay), not a collapsed 0px bar.
    expect(result).toEqual<TimelineBar[]>([
      { objectId: 'obj-5', left: 90, width: pxPerDay, clampedStart: false, clampedEnd: false },
    ]);
  });

  it('excludes an object with a missing end field value from the result', () => {
    const result = computeBarLayout(
      [{ id: 'obj-6', fieldValues: { start: '2026-03-05' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    expect(result).toEqual([]);
  });

  it('excludes an object with a malformed (non-date-like) end field value from the result', () => {
    const result = computeBarLayout(
      [{ id: 'obj-7', fieldValues: { start: '2026-03-05', end: 'not-a-date' } }],
      'start',
      'end',
      range,
      pxPerDay,
    );

    expect(result).toEqual([]);
  });

  it('excludes an object with a missing start field value while keeping other valid objects', () => {
    const result = computeBarLayout(
      [
        { id: 'obj-8', fieldValues: { end: '2026-03-10' } },
        { id: 'obj-9', fieldValues: { start: '2026-03-05', end: '2026-03-10' } },
      ],
      'start',
      'end',
      range,
      pxPerDay,
    );

    expect(result).toEqual<TimelineBar[]>([
      { objectId: 'obj-9', left: 40, width: 50, clampedStart: false, clampedEnd: false },
    ]);
  });
});
