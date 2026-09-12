import { describe, expect, it } from 'vitest';

import { computeAggregate } from '@luminaos/core-objects';
import type { AggregateFn } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';

import { computeQueryAggregate } from './compute-query-aggregate.js';

/**
 * F3-T10 PR1 (RED step), ADR-0044 Karar (e) —
 * `packages/artifacts/src/compute-query-aggregate.ts`.
 *
 *   export function computeQueryAggregate(
 *     rows: { title: string; fieldValues: Record<string, unknown> }[],
 *     aggregateFn: AggregateFn,
 *     targetFieldKey?: string,
 *   ): number | null;
 *
 * Expected to fail (red) until `implementer`:
 *   1. adds `packages/artifacts/src/compute-query-aggregate.ts` (module does
 *      not exist yet at all -- "Cannot find module" for that relative import), and
 *   2. adds `@luminaos/core-objects: workspace:*` to
 *      `packages/artifacts/package.json` (it is not a declared dependency
 *      today -- the `@luminaos/core-objects` import below is also expected
 *      to fail to resolve until that dependency is added).
 *
 * `computeAggregate`/`AggregateFn` are imported here REAL/un-mocked (already
 * public API of `@luminaos/core-objects`, F1-T4) -- proves correct
 * delegation end-to-end, not a stubbed return value.
 */

interface QueryResultRow {
  title: string;
  fieldValues: Record<string, unknown>;
}

function buildRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    title: 'Örnek Satır',
    fieldValues: {},
    ...overrides,
  };
}

const NON_COUNT_AGGREGATE_FNS = ['sum', 'avg', 'min', 'max', 'countUnique', 'countEmpty'] as const;

describe('computeQueryAggregate — "count" without targetFieldKey (row count, ADR-0044 Karar e)', () => {
  it('returns 0 for an empty rows array (not null, not a throw)', () => {
    expect(computeQueryAggregate([], 'count')).toBe(0);
  });

  it('returns 1 for a single row', () => {
    expect(computeQueryAggregate([buildRow()], 'count')).toBe(1);
  });

  it('returns rows.length for several rows, regardless of their fieldValues content', () => {
    const rows = [
      buildRow({ title: 'A' }),
      buildRow({ title: 'B', fieldValues: { amount: 10 } }),
      buildRow({ title: 'C', fieldValues: { amount: null } }),
      buildRow({ title: 'D' }),
    ];

    expect(computeQueryAggregate(rows, 'count')).toBe(4);
  });
});

describe('computeQueryAggregate — "count" WITH targetFieldKey (delegates to computeAggregate on field values, NOT rows.length — ADR-0044 Karar e)', () => {
  it('counts non-empty field values across rows, which DIFFERS from plain row-count when some rows are missing/empty for that field', () => {
    const rows = [
      buildRow({ title: 'A', fieldValues: { amount: 10 } }),
      buildRow({ title: 'B', fieldValues: {} }), // missing key entirely
      buildRow({ title: 'C', fieldValues: { amount: 20 } }),
      buildRow({ title: 'D', fieldValues: { amount: null } }), // explicitly empty
    ];
    const values = rows.map((row) => row.fieldValues.amount);
    const expected = computeAggregate('count', values);

    const actual = computeQueryAggregate(rows, 'count', 'amount');

    expect(actual).toBe(expected);
    expect(actual).toBe(2);
    expect(actual).not.toBe(rows.length);
  });
});

describe('computeQueryAggregate — every non-"count" aggregateFn requires targetFieldKey (fail-closed, ADR-0044 Karar e)', () => {
  it.each(NON_COUNT_AGGREGATE_FNS)(
    'throws ValidationError when aggregateFn is "%s" and targetFieldKey is omitted',
    (aggregateFn) => {
      const rows = [buildRow({ fieldValues: { amount: 10 } })];

      expect(() => computeQueryAggregate(rows, aggregateFn as AggregateFn)).toThrow(
        ValidationError,
      );
    },
  );

  it.each(NON_COUNT_AGGREGATE_FNS)(
    'the ValidationError message for aggregateFn "%s" mentions the missing targetFieldKey requirement',
    (aggregateFn) => {
      const rows = [buildRow({ fieldValues: { amount: 10 } })];

      expect(() => computeQueryAggregate(rows, aggregateFn as AggregateFn)).toThrow(
        /targetFieldKey/i,
      );
    },
  );
});

describe('computeQueryAggregate — delegates to the REAL computeAggregate for every non-"count" aggregateFn when targetFieldKey IS provided', () => {
  const rows = [
    buildRow({ title: 'A', fieldValues: { amount: 10 } }),
    buildRow({ title: 'B', fieldValues: { amount: 20 } }),
    buildRow({ title: 'C', fieldValues: { amount: 30 } }),
  ];

  it('sum -> 60', () => {
    expect(computeQueryAggregate(rows, 'sum', 'amount')).toBe(60);
  });

  it('avg -> 20', () => {
    expect(computeQueryAggregate(rows, 'avg', 'amount')).toBe(20);
  });

  it('min -> 10', () => {
    expect(computeQueryAggregate(rows, 'min', 'amount')).toBe(10);
  });

  it('max -> 30', () => {
    expect(computeQueryAggregate(rows, 'max', 'amount')).toBe(30);
  });

  it('countUnique -> counts distinct non-empty values (duplicate values collapse)', () => {
    const statusRows = [
      buildRow({ title: 'A', fieldValues: { status: 'açık' } }),
      buildRow({ title: 'B', fieldValues: { status: 'açık' } }),
      buildRow({ title: 'C', fieldValues: { status: 'kapalı' } }),
    ];

    expect(computeQueryAggregate(statusRows, 'countUnique', 'status')).toBe(2);
  });

  it('countEmpty -> counts null/undefined/empty-string values across rows', () => {
    const noteRows = [
      buildRow({ title: 'A', fieldValues: { note: 'x' } }),
      buildRow({ title: 'B', fieldValues: { note: null } }),
      buildRow({ title: 'C', fieldValues: { note: undefined } }),
      buildRow({ title: 'D', fieldValues: { note: '' } }),
    ];

    expect(computeQueryAggregate(noteRows, 'countEmpty', 'note')).toBe(3);
  });
});

describe('computeQueryAggregate — targetFieldKey === "title" reads row.title, NOT row.fieldValues.title (mirrors deriveWidgetColumns/buildQueryResultTableSection\'s identical special-case)', () => {
  it('computes the aggregate from row.title values, proving the special-case branch is real and not reading fieldValues.title', () => {
    // Deliberately constructed so the two possible readings disagree:
    //   - via row.title:            ['Aynı', 'Aynı', 'Farklı'] -> 2 distinct
    //   - via row.fieldValues.title: ['YANLIŞ-1', 'YANLIŞ-2', 'YANLIŞ-3'] -> 3 distinct
    const rows = [
      { title: 'Aynı', fieldValues: { title: 'YANLIŞ-1' } },
      { title: 'Aynı', fieldValues: { title: 'YANLIŞ-2' } },
      { title: 'Farklı', fieldValues: { title: 'YANLIŞ-3' } },
    ];

    expect(computeQueryAggregate(rows, 'countUnique', 'title')).toBe(2);
  });
});

describe('computeQueryAggregate — a targetFieldKey missing entirely from fieldValues does not throw, flows through as undefined', () => {
  it('treats a row lacking the target field key the same as computeAggregate treats undefined in its "values" array (excluded from "count")', () => {
    const rows = [
      buildRow({ title: 'A', fieldValues: { amount: 5 } }),
      buildRow({ title: 'B', fieldValues: {} }), // no "amount" key at all
    ];

    expect(() => computeQueryAggregate(rows, 'count', 'amount')).not.toThrow();
    expect(computeQueryAggregate(rows, 'count', 'amount')).toBe(1);
  });
});
