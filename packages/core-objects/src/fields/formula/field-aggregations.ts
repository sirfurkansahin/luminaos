/**
 * Per F1-T4 plan: pure aggregation functions over an array of
 * `FormulaValue`-shaped values (e.g. values pulled from a relation's linked
 * objects, one column at a time), used by rollup-style formula expressions.
 *
 * "Empty" := `null` | `undefined` | `''`. A `FormulaErrorValue`-shaped object
 * (`{ formulaError: true, message }`) is "present"/non-empty for
 * count/countUnique/countEmpty purposes, but never numeric for
 * sum/avg/min/max purposes (silently skipped, never thrown).
 */
export type AggregateFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countUnique' | 'countEmpty';

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function toNumeric(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function computeAggregate(fn: AggregateFn, values: unknown[]): number | null {
  switch (fn) {
    case 'sum': {
      let total = 0;

      for (const value of values) {
        const numeric = toNumeric(value);
        if (numeric !== undefined) {
          total += numeric;
        }
      }

      return total;
    }
    case 'avg': {
      let total = 0;
      let count = 0;

      for (const value of values) {
        const numeric = toNumeric(value);
        if (numeric !== undefined) {
          total += numeric;
          count += 1;
        }
      }

      return count === 0 ? null : total / count;
    }
    case 'min': {
      let min: number | undefined;

      for (const value of values) {
        const numeric = toNumeric(value);
        if (numeric !== undefined && (min === undefined || numeric < min)) {
          min = numeric;
        }
      }

      return min ?? null;
    }
    case 'max': {
      let max: number | undefined;

      for (const value of values) {
        const numeric = toNumeric(value);
        if (numeric !== undefined && (max === undefined || numeric > max)) {
          max = numeric;
        }
      }

      return max ?? null;
    }
    case 'count': {
      return values.filter((value) => !isEmptyValue(value)).length;
    }
    case 'countUnique': {
      const distinct = new Set(values.filter((value) => !isEmptyValue(value)));
      return distinct.size;
    }
    case 'countEmpty': {
      return values.filter((value) => isEmptyValue(value)).length;
    }
  }
}
