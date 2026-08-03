// Pure day-offset-to-pixel layout math for the Timeline view (F1-T8 PR2).
// Converts each object's start/end date fields into a horizontal bar
// (`left`/`width` in px) positioned within the currently visible `range`,
// clamping bars that overflow the window's edges.

import { parseISODate } from '../../lib/dateMath.js';

export interface TimelineBar {
  objectId: string;
  left: number;
  width: number;
  clampedStart: boolean;
  clampedEnd: boolean;
}

export interface TimelineLayoutRange {
  start: string;
  end: string;
}

const DATE_LIKE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function extractISODay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE_LIKE_PREFIX.test(value)) {
    return undefined;
  }
  return value.slice(0, 10);
}

function dayOffset(iso: string, rangeStart: Date): number {
  const date = parseISODate(iso);
  return Math.round((date.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeBarLayout(
  objects: Array<{ id: string; fieldValues: Record<string, unknown> }>,
  startField: string,
  endField: string,
  range: TimelineLayoutRange,
  pxPerDay: number,
): TimelineBar[] {
  const rangeStart = parseISODate(range.start);
  const rangeEnd = parseISODate(range.end);
  const totalRangeDays = Math.round(
    (rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000),
  );

  const bars: TimelineBar[] = [];

  for (const object of objects) {
    const startISO = extractISODay(object.fieldValues[startField]);
    const endISO = extractISODay(object.fieldValues[endField]);
    if (startISO === undefined || endISO === undefined) {
      continue;
    }

    const startOffsetRaw = dayOffset(startISO, rangeStart);
    const endOffsetRaw = dayOffset(endISO, rangeStart);

    const clampedStart = startOffsetRaw < 0;
    const clampedEnd = endOffsetRaw > totalRangeDays;

    const startOffset = clamp(startOffsetRaw, 0, totalRangeDays);
    const endOffset = clamp(endOffsetRaw, 0, totalRangeDays);

    const left = startOffset * pxPerDay;
    const width = (endOffset - startOffset) * pxPerDay;

    bars.push({
      objectId: object.id,
      left,
      width: width === 0 ? pxPerDay : width,
      clampedStart,
      clampedEnd,
    });
  }

  return bars;
}
