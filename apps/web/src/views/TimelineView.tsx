import { useMemo, useRef, useState } from 'react';

import type { QuerySpec } from '@luminaos/shared';
import {
  Button,
  EmptyState,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@luminaos/ui';

import { useObjectsQuery } from '../hooks/useObjectsQuery.js';
import { detectDateFieldCandidates } from '../lib/dateFieldCandidates.js';
import { addDays, toISODate } from '../lib/dateMath.js';
import { computeVisibleRange } from './calendar/calendarQuery.js';
import { TimelineAxis } from './timeline/TimelineAxis.js';
import { TimelineBar } from './timeline/TimelineBar.js';
import { computeBarLayout } from './timeline/timelineLayout.js';
import { computeTimelineQuerySpec } from './timeline/timelineQuery.js';
import styles from './timeline/TimelineView.module.css';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

export interface TimelineViewProps {
  workspaceId: string;
  objectType: string;
}

// Fixed-width navigable window (see PR2 plan's "yorum kararı"): a true
// scroll-triggered infinite fetch is out of this PR's budget, so Prev/Next
// shifts a fixed `WINDOW_DAYS`-wide window instead — each shift produces a
// new query range (and therefore a new `useObjectsQuery` cache key), so only
// the visible window is ever fetched.
const WINDOW_DAYS = 30;
const PX_PER_DAY = 40;

export function TimelineView({ workspaceId, objectType }: TimelineViewProps) {
  // Bootstrap: same "derive shape from the first page" trick CalendarView
  // uses — no schema endpoint exists yet to know which fields are date-like.
  const bootstrapQuerySpec = useMemo<QuerySpec>(
    () => ({ objectType, filters: [], limit: 50 }),
    [objectType],
  );
  const bootstrapQuery = useObjectsQuery(workspaceId, bootstrapQuerySpec);
  const candidates = useMemo(() => {
    const objects =
      bootstrapQuery.data !== undefined && 'objects' in bootstrapQuery.data
        ? bootstrapQuery.data.objects
        : [];
    return detectDateFieldCandidates(objects);
  }, [bootstrapQuery.data]);

  const [selectedStartField, setSelectedStartField] = useState<string | undefined>(undefined);
  const [selectedEndField, setSelectedEndField] = useState<string | undefined>(undefined);
  const startField = selectedStartField ?? candidates[0];
  const endField = selectedEndField ?? candidates[1];

  const [anchor, setAnchor] = useState<Date>(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  });

  const windowEnd = useMemo(() => addDays(anchor, WINDOW_DAYS - 1), [anchor]);
  const range = useMemo(() => computeVisibleRange([anchor, windowEnd]), [anchor, windowEnd]);

  // `querySpec` includes `range` (derived from `anchor`), so Prev/Next
  // navigation produces a new query object -> a new `useObjectsQuery` cache
  // key -> automatic refetch (AC: "yalnızca görünen aralık sorgulanır").
  const querySpec = useMemo(
    () => computeTimelineQuerySpec(objectType, startField, endField, range),
    [objectType, startField, endField, range],
  );
  const mainQuery = useObjectsQuery(workspaceId, querySpec);

  const baseObjects = useMemo<ObjectWithFieldValues[]>(
    () =>
      mainQuery.data !== undefined && 'objects' in mainQuery.data ? mainQuery.data.objects : [],
    [mainQuery.data],
  );

  const bars = useMemo(
    () =>
      startField !== undefined && endField !== undefined
        ? computeBarLayout(baseObjects, startField, endField, range, PX_PER_DAY)
        : [],
    [baseObjects, startField, endField, range],
  );

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const focusRow = (index: number): void => {
    rowRefs.current[index]?.focus();
  };

  // Roving 1D keyboard navigation between bar rows — same convention as
  // CalendarGrid.tsx's 2D roving-tabindex, adapted to a single column.
  const handleRowKeyDown =
    (index: number) =>
    (event: KeyboardEvent<HTMLDivElement>): void => {
      switch (event.key) {
        case 'ArrowDown':
          if (index + 1 < bars.length) {
            focusRow(index + 1);
          }
          break;
        case 'ArrowUp':
          if (index - 1 >= 0) {
            focusRow(index - 1);
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    };

  const goPrev = (): void => {
    setAnchor((prev) => addDays(prev, -WINDOW_DAYS));
  };
  const goNext = (): void => {
    setAnchor((prev) => addDays(prev, WINDOW_DAYS));
  };

  // Same convention as CalendarView.tsx: only the bootstrap query gates the
  // full-page loading/error/empty triad. The range-scoped `mainQuery`
  // refetches silently on Prev/Next navigation.
  if (bootstrapQuery.isLoading || (bootstrapQuery.data === undefined && !bootstrapQuery.isError)) {
    return (
      <div data-testid="timeline-view-loading">
        <Skeleton height={40} />
        <Skeleton height={300} />
      </div>
    );
  }

  if (bootstrapQuery.isError) {
    return (
      <EmptyState
        data-testid="timeline-view-error"
        title="Bir hata oluştu"
        description="Nesneler yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  // Timeline needs *two* distinct date fields (start + end); fewer than two
  // candidates means there's nothing sensible to render.
  if (startField === undefined || endField === undefined) {
    return (
      <EmptyState
        data-testid="timeline-view-empty"
        title="Tarih alanları bulunamadı"
        description="Zaman çizelgesinde gösterilecek başlangıç ve bitiş tarihi olan nesne yok."
      />
    );
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <SelectRoot
          value={startField}
          onValueChange={(next) => {
            setSelectedStartField(next);
          }}
        >
          <SelectTrigger
            data-testid="timeline-start-field-select"
            aria-label="Başlangıç tarihi alanı seç"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {candidate}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>

        <SelectRoot
          value={endField}
          onValueChange={(next) => {
            setSelectedEndField(next);
          }}
        >
          <SelectTrigger
            data-testid="timeline-end-field-select"
            aria-label="Bitiş tarihi alanı seç"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {candidate}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>

        <Button
          variant="ghost"
          data-testid="timeline-nav-prev"
          aria-label="Önceki"
          onClick={goPrev}
        >
          ◀
        </Button>
        <span className={styles.windowLabel}>
          {toISODate(anchor)} – {toISODate(windowEnd)}
        </span>
        <Button
          variant="ghost"
          data-testid="timeline-nav-next"
          aria-label="Sonraki"
          onClick={goNext}
        >
          ▶
        </Button>
      </div>

      <div className={styles.canvas}>
        <TimelineAxis range={range} pxPerDay={PX_PER_DAY} />
        <div className={styles.rows} role="list" style={{ width: WINDOW_DAYS * PX_PER_DAY }}>
          {bars.map((bar, index) => {
            const object = baseObjects.find((candidate) => candidate.id === bar.objectId);
            if (object === undefined) {
              return null;
            }
            return (
              <div key={bar.objectId} className={styles.rowTrack}>
                <TimelineBar
                  object={object}
                  layout={bar}
                  registerRef={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  onKeyDown={handleRowKeyDown(index)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
