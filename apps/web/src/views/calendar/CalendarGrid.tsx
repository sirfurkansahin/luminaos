import { useDroppable } from '@dnd-kit/core';
import { useRef } from 'react';

import { CalendarObjectChip } from './CalendarObjectChip.js';
import styles from './CalendarView.module.css';
import { getTodayDateOnly, isSameDay, toISODate } from '../../lib/dateMath.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

const COLUMN_COUNT = 7;

export interface CalendarGridProps {
  days: Date[];
  itemsByDay: Record<string, ObjectWithFieldValues[]>;
}

export function CalendarGrid({ days, itemsByDay }: CalendarGridProps) {
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const today = getTodayDateOnly();

  const focusCell = (index: number): void => {
    cellRefs.current[index]?.focus();
  };

  // Roving 2D keyboard navigation across the grid — same arrow-key wiring
  // TableView.tsx already uses for its row/column grid, adapted to a
  // 7-column (weekday) grid regardless of month/week mode.
  const handleKeyDown =
    (index: number) =>
    (event: KeyboardEvent<HTMLDivElement>): void => {
      switch (event.key) {
        case 'ArrowRight':
          if (index + 1 < days.length) {
            focusCell(index + 1);
          }
          break;
        case 'ArrowLeft':
          if (index - 1 >= 0) {
            focusCell(index - 1);
          }
          break;
        case 'ArrowDown':
          if (index + COLUMN_COUNT < days.length) {
            focusCell(index + COLUMN_COUNT);
          }
          break;
        case 'ArrowUp':
          if (index - COLUMN_COUNT >= 0) {
            focusCell(index - COLUMN_COUNT);
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    };

  const rows: Date[][] = [];
  for (let i = 0; i < days.length; i += COLUMN_COUNT) {
    rows.push(days.slice(i, i + COLUMN_COUNT));
  }

  return (
    <div role="grid" className={styles.grid} data-testid="calendar-grid">
      {rows.map((week, rowIndex) => (
        <div
          role="row"
          key={week[0] !== undefined ? toISODate(week[0]) : rowIndex}
          className={styles.row}
        >
          {week.map((day, colIndex) => {
            const index = rowIndex * COLUMN_COUNT + colIndex;
            const iso = toISODate(day);
            return (
              <DayCell
                key={iso}
                day={day}
                iso={iso}
                isToday={isSameDay(day, today)}
                items={itemsByDay[iso] ?? []}
                registerRef={(element) => {
                  cellRefs.current[index] = element;
                }}
                onKeyDown={handleKeyDown(index)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface DayCellProps {
  day: Date;
  iso: string;
  isToday: boolean;
  items: ObjectWithFieldValues[];
  registerRef: (element: HTMLDivElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function DayCell({ day, iso, isToday, items, registerRef, onKeyDown }: DayCellProps) {
  const { setNodeRef } = useDroppable({ id: iso });

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        registerRef(element);
      }}
      role="gridcell"
      data-testid="calendar-day-cell"
      data-date={iso}
      aria-current={isToday ? 'date' : undefined}
      tabIndex={0}
      className={[styles.dayCell, isToday ? styles.dayCellToday : undefined]
        .filter(Boolean)
        .join(' ')}
      onKeyDown={onKeyDown}
    >
      <span className={styles.dayNumber}>{day.getUTCDate()}</span>
      {items.map((object) => (
        <CalendarObjectChip key={object.id} object={object} />
      ))}
    </div>
  );
}
