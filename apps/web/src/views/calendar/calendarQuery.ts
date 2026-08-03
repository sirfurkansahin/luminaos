import { ValidationError, type QuerySpec } from '@luminaos/shared';

import { toISODate } from '../../lib/dateMath.js';

export interface VisibleRange {
  start: string;
  end: string;
}

export function computeVisibleRange(gridDays: Date[]): VisibleRange {
  const first = gridDays[0];
  const last = gridDays[gridDays.length - 1];
  if (first === undefined || last === undefined) {
    throw new ValidationError('computeVisibleRange requires a non-empty gridDays array');
  }
  return { start: toISODate(first), end: toISODate(last) };
}

export function computeCalendarQuerySpec(
  objectType: string,
  dateField: string | undefined,
  range: VisibleRange | undefined,
): QuerySpec {
  if (dateField === undefined || range === undefined) {
    return { objectType, filters: [] };
  }

  return {
    objectType,
    filters: [{ field: dateField, operator: 'between', value: [range.start, range.end] }],
  };
}
