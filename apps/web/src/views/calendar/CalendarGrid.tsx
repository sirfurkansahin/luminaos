import { useDroppable } from '@dnd-kit/core';
import { useRef } from 'react';

import { CalendarObjectChip } from './CalendarObjectChip.js';
import styles from './CalendarView.module.css';
import { ExternalEventChip } from './ExternalEventChip.js';
import { getTodayDateOnly, isSameDay, toISODate } from '../../lib/dateMath.js';

import type { ExternalCalendarEvent, ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

const COLUMN_COUNT = 7;

// F1-T12 PR8a — read-only external-calendar sync (ADR-0012 §a/§b): a day
// cell can hold a mix of writable LuminaOS objects and read-only external
// events, discriminated by `kind` so DayCell can dispatch to the right chip.
export type CalendarDayItem =
  | { kind: 'object'; object: ObjectWithFieldValues; hasConflict: boolean }
  | { kind: 'external'; event: ExternalCalendarEvent };

export interface CalendarGridProps {
  days: Date[];
  itemsByDay: Record<string, CalendarDayItem[]>;
  // F1-T12 PR8b — click-day-to-create-timeblock (the accepted substitute for
  // pixel-precise drag-to-create). Fired only when the day cell's own
  // background is clicked, never when a chip inside it is clicked (see
  // DayCell's `event.target === event.currentTarget` guard below).
  onDayClick?: (dateISO: string) => void;
}

export function CalendarGrid({ days, itemsByDay, onDayClick }: CalendarGridProps) {
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
                onDayClick={onDayClick}
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
  items: CalendarDayItem[];
  registerRef: (element: HTMLDivElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  // Widened to explicitly accept `| undefined` (rather than a plain optional
  // key) — under this repo's `exactOptionalPropertyTypes`, `CalendarGrid`
  // forwards its own optional `onDayClick` prop (typed `T | undefined` since
  // it may be omitted by its caller) as an explicit value, which a merely-
  // optional target prop type would reject.
  onDayClick?: ((dateISO: string) => void) | undefined;
}

function DayCell({ day, iso, isToday, items, registerRef, onKeyDown, onDayClick }: DayCellProps) {
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
      onClick={(event) => {
        // Only the cell's own background click opens the create-timeblock
        // modal — a click that bubbled up from a chip (CalendarObjectChip/
        // ExternalEventChip) must NOT trigger it (regression proof that chip
        // drag/click interactions aren't hijacked by this new handler).
        if (event.target === event.currentTarget) {
          onDayClick?.(iso);
        }
      }}
    >
      <span className={styles.dayNumber}>{day.getUTCDate()}</span>
      {items.map((item) =>
        item.kind === 'object' ? (
          <CalendarObjectChip
            key={item.object.id}
            object={item.object}
            hasConflict={item.hasConflict}
          />
        ) : (
          <ExternalEventChip key={item.event.externalId} event={item.event} />
        ),
      )}
    </div>
  );
}
