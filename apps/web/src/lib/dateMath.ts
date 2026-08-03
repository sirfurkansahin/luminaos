// UTC-anchored date utilities shared by the Calendar (F1-T8 PR1) and Timeline
// (F1-T8 PR2) views. Every function operates on `Date.UTC`/`getUTC*`
// accessors exclusively — never local-timezone fields — so grid/arithmetic
// results never drift depending on the host process's local timezone or DST
// transitions (see docs/specs/F1-E2/F1-T8-calendar-timeline.md).

const MS_PER_DAY = 86_400_000;

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

export function toISODate(date: Date): string {
  return `${date.getUTCFullYear().toString()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function parseISODate(iso: string): Date {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
}

export function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * MS_PER_DAY);
}

function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the *next* month is the last day of `monthIndex` — `Date.UTC`
  // normalizes an out-of-range `monthIndex` (e.g. 12, -1) automatically.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function addMonths(date: Date, n: number): Date {
  const year = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() + n;
  const clampedDay = Math.min(date.getUTCDate(), daysInMonth(year, targetMonth));
  return new Date(
    Date.UTC(
      year,
      targetMonth,
      clampedDay,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function startOfWeek(date: Date, weekStartsOn: 0 | 1): Date {
  let result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  while (result.getUTCDay() !== weekStartsOn) {
    result = addDays(result, -1);
  }
  return result;
}

export function isSameDay(a: Date, b: Date): boolean {
  return toISODate(a) === toISODate(b);
}

export function getTodayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function computeMonthGridDays(anchor: Date, weekStartsOn: 0 | 1): Date[] {
  const gridStart = startOfWeek(startOfMonth(anchor), weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function computeWeekGridDays(anchor: Date, weekStartsOn: 0 | 1): Date[] {
  const gridStart = startOfWeek(anchor, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(gridStart, i));
}

const monthLabelFormatter = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });

export function formatMonthLabel(date: Date): string {
  return monthLabelFormatter.format(date);
}
