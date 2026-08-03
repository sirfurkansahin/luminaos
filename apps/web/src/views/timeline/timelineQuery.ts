// Timeline's query construction (F1-T8 PR2). Unlike Calendar's single-field
// `between` filter, Timeline needs a true date-range OVERLAP query across two
// fields (object.start <= range.end AND object.end >= range.start).
// `DATE_OPERATORS` (packages/shared/src/query/query-spec.ts) only allows
// `before`/`after` for date/datetime fields — no `gte`/`lte` — so the strict
// comparisons are padded by ±1 day (via dateMath.ts's addDays/toISODate/
// parseISODate) to become inclusive at day granularity.
//
// Known limitation (see docs/specs/F1-E2/F1-T8-calendar-timeline.md): for
// `datetime` fields this ±1-day padding can over-include by up to ~24 hours;
// true sub-day overlap would require adding `gte`/`lte` to `DATE_OPERATORS`
// (a F1-T6 change, out of scope here).

import type { QuerySpec } from '@luminaos/shared';

import { addDays, parseISODate, toISODate } from '../../lib/dateMath.js';

export interface TimelineRange {
  start: string;
  end: string;
}

export function computeTimelineQuerySpec(
  objectType: string,
  startField: string | undefined,
  endField: string | undefined,
  range: TimelineRange | undefined,
): QuerySpec {
  if (startField === undefined || endField === undefined || range === undefined) {
    return { objectType, filters: [] };
  }

  const beforeBoundary = toISODate(addDays(parseISODate(range.end), 1));
  const afterBoundary = toISODate(addDays(parseISODate(range.start), -1));

  return {
    objectType,
    filters: [
      { field: startField, operator: 'before', value: beforeBoundary },
      { field: endField, operator: 'after', value: afterBoundary },
    ],
  };
}
