import { describe, expect, it } from 'vitest';

import { computeDateFieldUpdate } from './dragEndUpdate.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/calendar/dragEndUpdate.ts to satisfy these tests.
 * That's the expected TDD red state.):
 *
 *   export function computeDateFieldUpdate(
 *     dateField: string,
 *     objectId: string,
 *     currentValue: unknown,
 *     targetDateISO: string,
 *   ): { objectId: string; values: Record<string, unknown> } | null;
 *
 * Mirrors apps/web/src/views/board/dragEndUpdate.ts's `computeFieldUpdate`
 * shape/contract, but for a date-valued field instead of a group field:
 *
 * - If `currentValue` is a string matching /^\d{4}-\d{2}-\d{2}/ AND longer
 *   than 10 characters (i.e. a `datetime` value with a time-of-day
 *   component), only the leading 'YYYY-MM-DD' segment is replaced with
 *   `targetDateISO`; the time-of-day suffix (everything from index 10
 *   onward) is preserved verbatim.
 * - Otherwise (a plain 10-char 'YYYY-MM-DD' string, or anything else --
 *   missing/undefined/null/malformed) the value is replaced wholesale with
 *   `targetDateISO`.
 * - Returns `null` when the resulting date is unchanged from the current
 *   one -- compared by DATE-ONLY equality (the leading 'YYYY-MM-DD' segment
 *   of `currentValue`, when it's a valid date-like string, equals
 *   `targetDateISO`), not raw string equality. This matters specifically for
 *   datetime values: dropping a datetime card back onto the same calendar
 *   day it already occupies is a no-op even though its full string (with
 *   time-of-day) differs from `targetDateISO`.
 */

describe('computeDateFieldUpdate', () => {
  it('replaces a plain date value wholesale when dropped on a different day', () => {
    const result = computeDateFieldUpdate('dueDate', 'obj-1', '2026-08-03', '2026-08-10');

    expect(result).toEqual({ objectId: 'obj-1', values: { dueDate: '2026-08-10' } });
  });

  it('preserves the time-of-day suffix when moving a datetime value to a different day', () => {
    const result = computeDateFieldUpdate(
      'startsAt',
      'obj-2',
      '2026-08-03T14:30:00.000Z',
      '2026-08-10',
    );

    expect(result).toEqual({
      objectId: 'obj-2',
      values: { startsAt: '2026-08-10T14:30:00.000Z' },
    });
  });

  it('returns null for a same-day drop of a plain date value (no-op)', () => {
    const result = computeDateFieldUpdate('dueDate', 'obj-1', '2026-08-03', '2026-08-03');

    expect(result).toBeNull();
  });

  it('returns null for a same-day drop of a datetime value, even though the full string differs', () => {
    const result = computeDateFieldUpdate(
      'startsAt',
      'obj-2',
      '2026-08-03T14:30:00.000Z',
      '2026-08-03',
    );

    expect(result).toBeNull();
  });

  it('replaces wholesale when currentValue is undefined (object had no value for the field yet)', () => {
    const result = computeDateFieldUpdate('dueDate', 'obj-3', undefined, '2026-08-10');

    expect(result).toEqual({ objectId: 'obj-3', values: { dueDate: '2026-08-10' } });
  });

  it('replaces wholesale when currentValue is null', () => {
    const result = computeDateFieldUpdate('dueDate', 'obj-4', null, '2026-08-10');

    expect(result).toEqual({ objectId: 'obj-4', values: { dueDate: '2026-08-10' } });
  });

  it('replaces wholesale when currentValue is a malformed, non-date-like string', () => {
    const result = computeDateFieldUpdate('dueDate', 'obj-5', 'not-a-date', '2026-08-10');

    expect(result).toEqual({ objectId: 'obj-5', values: { dueDate: '2026-08-10' } });
  });

  it('replaces wholesale when currentValue is a non-string type (e.g. a number)', () => {
    const result = computeDateFieldUpdate('dueDate', 'obj-6', 20260803, '2026-08-10');

    expect(result).toEqual({ objectId: 'obj-6', values: { dueDate: '2026-08-10' } });
  });

  it('treats an exactly-10-character value as a plain date (not a datetime) even at the boundary', () => {
    // 10 chars exactly -- must NOT go through the "preserve time suffix"
    // branch (there is no suffix to preserve).
    const result = computeDateFieldUpdate('dueDate', 'obj-7', '2026-08-03', '2026-08-04');

    expect(result).toEqual({ objectId: 'obj-7', values: { dueDate: '2026-08-04' } });
  });
});
