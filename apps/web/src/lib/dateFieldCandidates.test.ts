import { describe, expect, it } from 'vitest';

import { detectDateFieldCandidates } from './dateFieldCandidates.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/lib/dateFieldCandidates.ts to satisfy these tests. That's the
 * expected TDD red state.):
 *
 *   export function detectDateFieldCandidates(
 *     objects: Array<{ fieldValues: Record<string, unknown> }>,
 *   ): string[];
 *
 * Scans `fieldValues` across every given object for values that are strings
 * matching a leading 'YYYY-MM-DD' pattern (covers both the `date` custom
 * field type, whose stored value IS exactly 'YYYY-MM-DD', and `datetime`,
 * whose stored value is a full ISO datetime that STARTS WITH 'YYYY-MM-DD').
 * A non-string value (number, boolean, null, object, array) never counts,
 * even if it happens to look date-like once coerced to a string. Returns the
 * sorted (ascending, string comparison) union of matching field keys across
 * every object in the input — a field only needs to match in at least one
 * object to be included; it does not need to be present/populated in all of
 * them.
 */

describe('detectDateFieldCandidates', () => {
  it('detects both date and datetime typed fields, ignoring text/number/boolean fields', () => {
    const result = detectDateFieldCandidates([
      {
        fieldValues: {
          title: 'Launch prep',
          priority: 5,
          isDone: false,
          dueDate: '2026-08-03',
          createdAt: '2026-08-03T10:15:00.000Z',
        },
      },
    ]);

    expect(result).toEqual(['createdAt', 'dueDate']);
  });

  it('returns an empty array for an empty objects array', () => {
    expect(detectDateFieldCandidates([])).toEqual([]);
  });

  it('returns an empty array when no object has any date-like field values', () => {
    const result = detectDateFieldCandidates([
      { fieldValues: { title: 'Some text', priority: 5 } },
      { fieldValues: {} },
    ]);

    expect(result).toEqual([]);
  });

  it('unions candidate keys across multiple objects even when only some have the field populated', () => {
    const result = detectDateFieldCandidates([
      { fieldValues: { dueDate: '2026-08-03', priority: 1 } },
      { fieldValues: { startDate: '2026-09-01' } },
      { fieldValues: {} },
    ]);

    expect(result).toEqual(['dueDate', 'startDate']);
  });

  it('does not require a field to be populated in every object to be detected', () => {
    const result = detectDateFieldCandidates([
      { fieldValues: { dueDate: '2026-08-03' } },
      { fieldValues: { dueDate: undefined } },
      { fieldValues: {} },
    ]);

    expect(result).toEqual(['dueDate']);
  });

  it('ignores non-string values even when they look date-like once stringified', () => {
    const result = detectDateFieldCandidates([
      {
        fieldValues: {
          numericCode: 20260803,
          nullField: null,
          objectField: { year: 2026, month: 8, day: 3 },
          arrayField: ['2026-08-03'],
        },
      },
    ]);

    expect(result).toEqual([]);
  });

  it('rejects strings that only partially resemble YYYY-MM-DD (not zero-padded / no dashes)', () => {
    const result = detectDateFieldCandidates([
      {
        fieldValues: {
          looseDate: '2026-8-3',
          noDashes: '20260803',
          freeText: 'Not a date value at all',
        },
      },
    ]);

    expect(result).toEqual([]);
  });

  it('sorts the resulting field keys ascending', () => {
    const result = detectDateFieldCandidates([
      {
        fieldValues: {
          zLastField: '2026-08-03',
          aFirstField: '2026-08-04',
          mMiddleField: '2026-08-05',
        },
      },
    ]);

    expect(result).toEqual(['aFirstField', 'mMiddleField', 'zLastField']);
  });
});
