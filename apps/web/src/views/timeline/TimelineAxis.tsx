// Day-tick axis rendered above the Timeline's bar rows, plus a "today"
// vertical marker positioned with the same day-offset-to-px math
// `computeBarLayout` uses for bars (so the marker visually lines up with
// bars sharing the same day column).

import styles from './TimelineView.module.css';
import { addDays, getTodayDateOnly, parseISODate, toISODate } from '../../lib/dateMath.js';

export interface TimelineAxisProps {
  range: { start: string; end: string };
  pxPerDay: number;
}

const MS_PER_DAY = 86_400_000;

export function TimelineAxis({ range, pxPerDay }: TimelineAxisProps) {
  const rangeStart = parseISODate(range.start);
  const rangeEnd = parseISODate(range.end);
  const totalDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / MS_PER_DAY) + 1;
  const days = Array.from({ length: totalDays }, (_, i) => addDays(rangeStart, i));

  const today = getTodayDateOnly();
  const todayOffset = Math.round((today.getTime() - rangeStart.getTime()) / MS_PER_DAY);
  const isTodayVisible = todayOffset >= 0 && todayOffset < totalDays;

  return (
    <div className={styles.axis} style={{ width: totalDays * pxPerDay }}>
      {days.map((day) => (
        <span key={toISODate(day)} className={styles.axisTick} style={{ width: pxPerDay }}>
          {day.getUTCDate()}
        </span>
      ))}
      {isTodayVisible && (
        <div
          data-testid="timeline-today-marker"
          className={styles.todayMarker}
          style={{ left: todayOffset * pxPerDay }}
        />
      )}
    </div>
  );
}
