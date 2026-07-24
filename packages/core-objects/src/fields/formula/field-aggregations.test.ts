import { describe, expect, it } from 'vitest';

import { computeAggregate } from './field-aggregations.js';

/**
 * F1-T4 PR-A2 (RED step) — pure aggregation functions over an array of
 * `FormulaValue`-shaped values (e.g. values pulled from a relation's linked
 * objects, one column at a time), used by rollup-style formula expressions.
 *
 * Designed API (must be matched exactly by implementer):
 *
 *   type AggregateFn = 'sum' | 'avg' | 'min' | 'max' | 'count'
 *     | 'countUnique' | 'countEmpty';
 *
 *   computeAggregate(fn: AggregateFn, values: unknown[]): number | null
 *
 * Semantics pinned by this file (see per-function describe blocks + the
 * combined fixture table at the bottom, which pins all 7 functions against
 * the SAME mixed array in one place):
 *
 *   - "empty" value := null | undefined | '' (empty string).
 *   - A FormulaErrorValue-shaped object ({ formulaError: true, message })
 *     is "present"/non-empty for count / countUnique / countEmpty purposes, but NOT
 *     numeric for sum/avg/min/max purposes (silently skipped, never
 *     thrown).
 *   - sum: 0 when there are zero qualifying numeric values (sum of nothing
 *     is 0, distinct from avg's null-on-empty).
 *   - avg/min/max: null when there are zero qualifying numeric values.
 *   - count: total values minus empty ones (numbers, strings, booleans all
 *     count; only null/undefined/'' are excluded).
 *   - countUnique: count of distinct non-empty values (Set-based dedup;
 *     values are always FormulaValue-shaped primitives in practice, no
 *     deep-object dedup needed).
 *   - countEmpty: count of values that ARE null/undefined/''.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/core-objects/src/fields/formula/field-aggregations.ts`.
 */

const FORMULA_ERROR = { formulaError: true, message: 'e' } as const;

describe('computeAggregate("sum", ...)', () => {
  it('adds all numeric values', () => {
    expect(computeAggregate('sum', [1, 2, 3])).toBe(6);
  });

  it('skips null, undefined, non-numeric, and FormulaErrorValue-shaped entries silently', () => {
    expect(computeAggregate('sum', [1, null, undefined, 'x', FORMULA_ERROR, 2])).toBe(3);
  });

  it('returns 0 for an empty array', () => {
    expect(computeAggregate('sum', [])).toBe(0);
  });

  it('returns 0 when every value is skipped (all non-numeric)', () => {
    expect(computeAggregate('sum', [null, undefined, 'x', FORMULA_ERROR])).toBe(0);
  });
});

describe('computeAggregate("avg", ...)', () => {
  it('averages the numeric values', () => {
    expect(computeAggregate('avg', [1, 2, 3])).toBe(2);
  });

  it('skips non-numeric entries when averaging', () => {
    expect(computeAggregate('avg', [2, 4, 'x', null])).toBe(3);
  });

  it('returns null for an empty array (never divide by zero)', () => {
    expect(computeAggregate('avg', [])).toBeNull();
  });

  it('returns null when there are zero qualifying numeric values', () => {
    expect(computeAggregate('avg', [null, undefined, '', FORMULA_ERROR])).toBeNull();
  });
});

describe('computeAggregate("min", ...)', () => {
  it('returns the smallest numeric value', () => {
    expect(computeAggregate('min', [5, 1, 3])).toBe(1);
  });

  it('skips non-numeric values', () => {
    expect(computeAggregate('min', [5, 'x', 1, null])).toBe(1);
  });

  it('returns null when there are zero qualifying numeric values', () => {
    expect(computeAggregate('min', ['x', null, undefined])).toBeNull();
  });
});

describe('computeAggregate("max", ...)', () => {
  it('returns the largest numeric value', () => {
    expect(computeAggregate('max', [5, 1, 3])).toBe(5);
  });

  it('skips non-numeric values', () => {
    expect(computeAggregate('max', [5, 'x', 9, null])).toBe(9);
  });

  it('returns null when there are zero qualifying numeric values', () => {
    expect(computeAggregate('max', ['x', null, undefined])).toBeNull();
  });
});

describe('computeAggregate("count", ...)', () => {
  it('counts non-empty values, including non-numeric ones like strings and booleans', () => {
    expect(computeAggregate('count', [1, 'x', true, false])).toBe(4);
  });

  it('excludes null, undefined, and empty-string entries', () => {
    expect(computeAggregate('count', [1, null, undefined, '', 'x'])).toBe(2);
  });

  it('counts a FormulaErrorValue-shaped entry as present (not empty)', () => {
    expect(computeAggregate('count', [FORMULA_ERROR, null])).toBe(1);
  });

  it('returns 0 for an empty array', () => {
    expect(computeAggregate('count', [])).toBe(0);
  });
});

describe('computeAggregate("countUnique", ...)', () => {
  it('counts distinct non-empty values', () => {
    expect(computeAggregate('countUnique', [1, 2, 2, 3, 1])).toBe(3);
  });

  it('excludes empty entries from both the count and the dedup set', () => {
    expect(computeAggregate('countUnique', [1, null, undefined, '', 1])).toBe(1);
  });

  it('returns 0 for an empty array', () => {
    expect(computeAggregate('countUnique', [])).toBe(0);
  });
});

describe('computeAggregate("countEmpty", ...)', () => {
  it('counts null, undefined, and empty-string entries', () => {
    expect(computeAggregate('countEmpty', [null, undefined, '', 1, 'x'])).toBe(3);
  });

  it('returns 0 when there are no empty entries', () => {
    expect(computeAggregate('countEmpty', [1, 2, 3])).toBe(0);
  });

  it('returns 0 for an empty array', () => {
    expect(computeAggregate('countEmpty', [])).toBe(0);
  });

  it('does not count a FormulaErrorValue-shaped entry as empty', () => {
    expect(computeAggregate('countEmpty', [FORMULA_ERROR])).toBe(0);
  });
});

describe('all 7 aggregate functions pinned against the same mixed fixture', () => {
  // 1, 2, null, 'x', 2, undefined, '', { formulaError: true, message: 'e' }
  const mixed: unknown[] = [1, 2, null, 'x', 2, undefined, '', FORMULA_ERROR];

  it.each<[string, number | null]>([
    ['sum', 5], // 1 + 2 + 2 (skip null, 'x', undefined, '', FORMULA_ERROR)
    ['avg', 5 / 3], // average of [1, 2, 2]
    ['min', 1],
    ['max', 2],
    ['count', 5], // total 8 minus 3 empties (null, undefined, '') = 5 present values
    ['countUnique', 4], // distinct non-empty: 1, 2, 'x', FORMULA_ERROR
    ['countEmpty', 3], // null, undefined, '' -- three entries
  ])('%s', (fn, expected) => {
    expect(computeAggregate(fn as never, mixed)).toBeCloseTo(expected ?? Number.NaN, 10);
  });
});
