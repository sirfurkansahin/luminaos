import { computeAggregate } from '@luminaos/core-objects';
import type { AggregateFn } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';

/**
 * ADR-0044 Karar (e) — computes an aggregate over a set of query result
 * rows. Mirrors `deriveWidgetColumns`/`buildQueryResultTableSection`'s
 * special-case: `targetFieldKey === 'title'` reads `row.title` rather than
 * `row.fieldValues.title`.
 *
 * `'count'` without a `targetFieldKey` returns the plain row count
 * (`rows.length`) rather than delegating to `computeAggregate` -- every
 * other `aggregateFn`, and `'count'` WITH a `targetFieldKey`, requires
 * `targetFieldKey` and delegates to the real `computeAggregate`.
 */
export function computeQueryAggregate(
  rows: { title: string; fieldValues: Record<string, unknown> }[],
  aggregateFn: AggregateFn,
  targetFieldKey?: string,
): number | null {
  if (aggregateFn === 'count' && targetFieldKey === undefined) {
    return rows.length;
  }

  if (targetFieldKey === undefined) {
    throw new ValidationError('targetFieldKey is required for this aggregateFn', {
      aggregateFn,
    });
  }

  const values = rows.map((row) =>
    targetFieldKey === 'title' ? row.title : row.fieldValues[targetFieldKey],
  );

  return computeAggregate(aggregateFn, values);
}
