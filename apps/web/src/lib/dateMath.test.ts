import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addDays,
  addMonths,
  computeMonthGridDays,
  computeWeekGridDays,
  formatMonthLabel,
  getTodayDateOnly,
  isSameDay,
  parseISODate,
  startOfMonth,
  startOfWeek,
  toISODate,
} from './dateMath.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/lib/dateMath.ts to satisfy these tests. That's the expected
 * TDD red state.):
 *
 *   export function toISODate(date: Date): string; // 'YYYY-MM-DD', built
 *       // from the UTC calendar fields of `date` (getUTCFullYear/Month/Date)
 *       // — never local-timezone fields.
 *   export function parseISODate(iso: string): Date; // UTC midnight of the
 *       // given 'YYYY-MM-DD' string.
 *   export function addDays(date: Date, n: number): Date;
 *   export function addMonths(date: Date, n: number): Date; // clamps at
 *       // month-end instead of overflowing (Date's native setMonth would
 *       // silently roll Jan 31 + 1 month into Mar 3).
 *   export function startOfMonth(date: Date): Date;
 *   export function startOfWeek(date: Date, weekStartsOn: 0 | 1): Date; // 1 = Monday
 *   export function isSameDay(a: Date, b: Date): boolean; // compares UTC
 *       // calendar day only, ignoring time-of-day.
 *   export function getTodayDateOnly(): Date; // UTC midnight of the current
 *       // instant's UTC calendar date (new Date()'s getUTCFullYear/Month/Date)
 *       // — deterministic regardless of the process's local TZ.
 *   export function computeMonthGridDays(anchor: Date, weekStartsOn: 0 | 1): Date[];
 *       // exactly 42 entries (6 full weeks), starting on the most recent
 *       // `weekStartsOn` weekday at-or-before the 1st of anchor's month, and
 *       // padded with adjacent-month days to fill out the trailing week.
 *   export function computeWeekGridDays(anchor: Date, weekStartsOn: 0 | 1): Date[];
 *       // exactly 7 entries, starting on the most recent `weekStartsOn`
 *       // weekday at-or-before `anchor`.
 *   export function formatMonthLabel(date: Date): string; // Turkish month
 *       // name + year via Intl.DateTimeFormat('tr-TR', { month: 'long',
 *       // year: 'numeric' }), e.g. "Ağustos 2026".
 *
 * Every function is UTC-anchored (uses Date.UTC / getUTC* accessors) so that
 * grid/arithmetic results never drift depending on the host process's local
 * timezone or DST transitions.
 */

function utc(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

const ONE_DAY_MS = 86_400_000;

function addDaysUtc(date: Date, n: number): Date {
  return new Date(date.getTime() + n * ONE_DAY_MS);
}

/** Independent oracle for the expected 42-day month grid — deliberately not
 * reusing `computeMonthGridDays` itself, just plain Date arithmetic. */
function expectedMonthGrid(year: number, monthIndex: number, weekStartsOn: 0 | 1): Date[] {
  const monthStart = utc(year, monthIndex, 1);
  let gridStart = monthStart;
  while (gridStart.getUTCDay() !== weekStartsOn) {
    gridStart = addDaysUtc(gridStart, -1);
  }
  return Array.from({ length: 42 }, (_, i) => addDaysUtc(gridStart, i));
}

/** Independent oracle for the expected 7-day week grid. */
function expectedWeekGrid(anchor: Date, weekStartsOn: 0 | 1): Date[] {
  let gridStart = utc(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  while (gridStart.getUTCDay() !== weekStartsOn) {
    gridStart = addDaysUtc(gridStart, -1);
  }
  return Array.from({ length: 7 }, (_, i) => addDaysUtc(gridStart, i));
}

describe('toISODate', () => {
  it.each([
    [utc(2026, 7, 3), '2026-08-03'],
    [utc(2026, 0, 1), '2026-01-01'],
    [utc(2026, 11, 31), '2026-12-31'],
    // Single-digit month/day must still be zero-padded.
    [utc(2026, 8, 9), '2026-09-09'],
  ])('formats %s as %s', (date, expected) => {
    expect(toISODate(date)).toBe(expected);
  });

  it('uses UTC calendar fields, not local-timezone fields', () => {
    // A date constructed with a non-midnight UTC time must still report the
    // same UTC calendar day.
    const date = new Date(Date.UTC(2026, 7, 3, 23, 59, 59));
    expect(toISODate(date)).toBe('2026-08-03');
  });
});

describe('parseISODate', () => {
  it('parses a YYYY-MM-DD string into UTC midnight of that day', () => {
    const result = parseISODate('2026-08-03');
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(7);
    expect(result.getUTCDate()).toBe(3);
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });

  it('round-trips with toISODate', () => {
    expect(toISODate(parseISODate('2026-02-28'))).toBe('2026-02-28');
  });
});

describe('addDays', () => {
  it.each<[Date, number, string]>([
    [utc(2026, 7, 3), 1, '2026-08-04'],
    [utc(2026, 7, 3), -1, '2026-08-02'],
    [utc(2026, 7, 3), 0, '2026-08-03'],
    // Crosses a month boundary.
    [utc(2026, 7, 31), 1, '2026-09-01'],
    // Crosses a year boundary.
    [utc(2026, 11, 31), 1, '2027-01-01'],
    // Crosses the (real, non-existent-in-this-repo) DST boundary month —
    // since arithmetic is UTC-anchored this must not skip or duplicate a day.
    [utc(2026, 9, 24), 1, '2026-10-25'],
    [utc(2026, 9, 25), 1, '2026-10-26'],
  ])('addDays(%s, %i) === %s', (date, n, expected) => {
    expect(toISODate(addDays(date, n))).toBe(expected);
  });
});

describe('addMonths', () => {
  it.each<[Date, number, string]>([
    // Plain case, no clamping needed.
    [utc(2026, 0, 15), 1, '2026-02-15'],
    // Month-end clamp: Jan 31 + 1 month must land on Feb 28 (2026 is not a
    // leap year), never silently overflow into March.
    [utc(2026, 0, 31), 1, '2026-02-28'],
    // Same case in a leap year: Feb has 29 days.
    [utc(2028, 0, 31), 1, '2028-02-29'],
    // Clamp still applies going further out.
    [utc(2026, 0, 31), 3, '2026-04-30'],
    // Negative n.
    [utc(2026, 2, 15), -1, '2026-02-15'],
    [utc(2026, 2, 31), -1, '2026-02-28'],
  ])('addMonths(%s, %i) === %s', (date, n, expected) => {
    expect(toISODate(addMonths(date, n))).toBe(expected);
  });
});

describe('startOfMonth', () => {
  it.each<[Date, string]>([
    [utc(2026, 7, 15), '2026-08-01'],
    [utc(2026, 7, 1), '2026-08-01'],
    [utc(2026, 7, 31), '2026-08-01'],
  ])('startOfMonth(%s) === %s', (date, expected) => {
    expect(toISODate(startOfMonth(date))).toBe(expected);
  });
});

describe('startOfWeek', () => {
  // 2026-08-05 is a Wednesday.
  it.each<[Date, 0 | 1, string]>([
    [utc(2026, 7, 5), 1, '2026-08-03'], // Monday
    [utc(2026, 7, 5), 0, '2026-08-02'], // Sunday
    // Anchor already IS the week-start day -> returns the same day.
    [utc(2026, 7, 3), 1, '2026-08-03'],
    [utc(2026, 7, 2), 0, '2026-08-02'],
  ])('startOfWeek(%s, weekStartsOn=%i) === %s', (date, weekStartsOn, expected) => {
    expect(toISODate(startOfWeek(date, weekStartsOn))).toBe(expected);
  });
});

describe('isSameDay', () => {
  it('returns true for the same UTC calendar day at different times', () => {
    const a = new Date(Date.UTC(2026, 7, 3, 0, 0, 0));
    const b = new Date(Date.UTC(2026, 7, 3, 23, 59, 59));
    expect(isSameDay(a, b)).toBe(true);
  });

  it('returns false for different UTC calendar days', () => {
    const a = new Date(Date.UTC(2026, 7, 3, 23, 0, 0));
    const b = new Date(Date.UTC(2026, 7, 4, 1, 0, 0));
    expect(isSameDay(a, b)).toBe(false);
  });

  it('returns false across a year boundary even when month/day match', () => {
    const a = new Date(Date.UTC(2026, 7, 3));
    const b = new Date(Date.UTC(2027, 7, 3));
    expect(isSameDay(a, b)).toBe(false);
  });
});

describe('getTodayDateOnly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns UTC midnight of the current instant's UTC calendar date", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 3, 15, 30, 45)));

    const result = getTodayDateOnly();

    expect(toISODate(result)).toBe('2026-08-03');
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });

  it('tracks a different mocked system date', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 11, 31, 0, 0, 1)));

    expect(toISODate(getTodayDateOnly())).toBe('2026-12-31');
  });
});

describe('computeMonthGridDays', () => {
  it.each<[0 | 1]>([[0], [1]])(
    'returns exactly 42 contiguous days for August 2026 (weekStartsOn=%i)',
    (weekStartsOn) => {
      const anchor = utc(2026, 7, 15);
      const result = computeMonthGridDays(anchor, weekStartsOn);

      expect(result).toHaveLength(42);
      expect(result).toEqual(expectedMonthGrid(2026, 7, weekStartsOn));
      expect(result[0]?.getUTCDay()).toBe(weekStartsOn);
    },
  );

  it.each<[0 | 1]>([[0], [1]])(
    'is unaffected by which day within the month the anchor is (weekStartsOn=%i)',
    (weekStartsOn) => {
      const fromFirst = computeMonthGridDays(utc(2026, 7, 1), weekStartsOn);
      const fromLast = computeMonthGridDays(utc(2026, 7, 31), weekStartsOn);

      expect(fromFirst).toEqual(fromLast);
    },
  );

  it.each<[0 | 1]>([[0], [1]])(
    'produces no skipped or duplicated day across the October 2026 DST-boundary month (weekStartsOn=%i)',
    (weekStartsOn) => {
      // Europe's DST ends on the last Sunday of October (2026-10-25). Since
      // this module is UTC-anchored, the grid must be a perfectly
      // contiguous run of calendar days regardless of that local-time
      // transition.
      const result = computeMonthGridDays(utc(2026, 9, 15), weekStartsOn);

      expect(result).toHaveLength(42);
      for (let i = 1; i < result.length; i += 1) {
        const prev = result[i - 1];
        const current = result[i];
        expect(prev).toBeDefined();
        expect(current).toBeDefined();
        expect((current as Date).getTime() - (prev as Date).getTime()).toBe(ONE_DAY_MS);
      }
      expect(result).toEqual(expectedMonthGrid(2026, 9, weekStartsOn));

      // The full month (Oct 1 through Oct 31) must be present.
      expect(result.map((d) => toISODate(d))).toEqual(
        expect.arrayContaining(['2026-10-01', '2026-10-25', '2026-10-31']),
      );
    },
  );
});

describe('computeWeekGridDays', () => {
  it.each<[0 | 1]>([[0], [1]])(
    'returns exactly 7 contiguous days containing the anchor (weekStartsOn=%i)',
    (weekStartsOn) => {
      const anchor = utc(2026, 7, 5); // Wednesday
      const result = computeWeekGridDays(anchor, weekStartsOn);

      expect(result).toHaveLength(7);
      expect(result).toEqual(expectedWeekGrid(anchor, weekStartsOn));
      expect(result[0]?.getUTCDay()).toBe(weekStartsOn);
      expect(result.map((d) => toISODate(d))).toContain('2026-08-05');
    },
  );

  it.each<[0 | 1]>([[0], [1]])(
    'produces no skipped or duplicated day across the October 2026 DST-boundary week (weekStartsOn=%i)',
    (weekStartsOn) => {
      const anchor = utc(2026, 9, 25); // DST-transition Sunday itself
      const result = computeWeekGridDays(anchor, weekStartsOn);

      expect(result).toHaveLength(7);
      for (let i = 1; i < result.length; i += 1) {
        const prev = result[i - 1];
        const current = result[i];
        expect(prev).toBeDefined();
        expect(current).toBeDefined();
        expect((current as Date).getTime() - (prev as Date).getTime()).toBe(ONE_DAY_MS);
      }
      expect(result).toEqual(expectedWeekGrid(anchor, weekStartsOn));
    },
  );
});

describe('formatMonthLabel', () => {
  it.each<[Date, string]>([
    [utc(2026, 7, 3), 'Ağustos 2026'],
    [utc(2026, 0, 1), 'Ocak 2026'],
    [utc(2026, 9, 15), 'Ekim 2026'],
    [utc(2026, 11, 31), 'Aralık 2026'],
  ])('formats %s as %s', (date, expected) => {
    expect(formatMonthLabel(date)).toBe(expected);
  });

  it("matches Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }) output", () => {
    const date = utc(2026, 4, 20);
    const expected = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(
      date,
    );
    expect(formatMonthLabel(date)).toBe(expected);
  });
});
