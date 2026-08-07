import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useEffect, useMemo, useState } from 'react';

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
  TabsList,
  TabsRoot,
  TabsTrigger,
} from '@luminaos/ui';

import {
  useCalendarConflictsQuery,
  useExternalCalendarEventsQuery,
} from '../hooks/useCalendarExtras.js';
import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';
import { detectDateFieldCandidates } from '../lib/dateFieldCandidates.js';
import {
  addDays,
  addMonths,
  computeMonthGridDays,
  computeWeekGridDays,
  formatMonthLabel,
} from '../lib/dateMath.js';
import { CalendarGrid } from './calendar/CalendarGrid.js';
import { computeCalendarQuerySpec, computeVisibleRange } from './calendar/calendarQuery.js';
import styles from './calendar/CalendarView.module.css';
import { CreateTimeblockModal } from './calendar/CreateTimeblockModal.js';
import { computeDateFieldUpdate } from './calendar/dragEndUpdate.js';

import type { CalendarDayItem } from './calendar/CalendarGrid.js';
import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { DragEndEvent } from '@dnd-kit/core';

export interface CalendarViewProps {
  workspaceId: string;
  objectType: string;
  // F1-T9 PR2: seeds the initially-selected date field (restoring a saved
  // view's stored `dateField`) instead of always defaulting to
  // `candidates[0]`. Optional, defaults to `undefined` (today's exact
  // pre-F1-T9 behavior).
  initialDateField?: string;
  // F1-T9 PR2: reports the currently-resolved date field (whether seeded via
  // `initialDateField`, defaulted to `candidates[0]`, or changed by the user
  // via the in-view Select) up to the caller, so "save current view" can
  // capture what's actually live instead of a stale/manually-retyped value.
  onDateFieldChange?: (dateField: string | undefined) => void;
}

type CalendarMode = 'month' | 'week';

const WEEK_STARTS_ON = 1; // Monday

const DATE_LIKE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function extractISODay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE_LIKE_PREFIX.test(value)) {
    return undefined;
  }
  return value.slice(0, 10);
}

export function CalendarView({
  workspaceId,
  objectType,
  initialDateField,
  onDateFieldChange,
}: CalendarViewProps) {
  // Bootstrap: an unfiltered, limited page used only to derive which
  // fieldValues keys look like date/datetime values (no schema endpoint
  // exists yet — same "derive shape from the first page" trick TableView.tsx
  // already uses). This gates the loading/error/empty triad below, since
  // nothing else in this view can render before a date field is known.
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

  const [selectedDateField, setSelectedDateField] = useState<string | undefined>(initialDateField);
  const dateField = selectedDateField ?? candidates[0];

  useEffect(() => {
    onDateFieldChange?.(dateField);
  }, [dateField, onDateFieldChange]);

  // F1-T12 PR8b — click-day-to-create-timeblock: `undefined` means no modal
  // is open; a date-only ISO string opens `CreateTimeblockModal` for that day.
  const [creatingForDate, setCreatingForDate] = useState<string | undefined>(undefined);

  const [mode, setMode] = useState<CalendarMode>('month');
  const [anchor, setAnchor] = useState<Date>(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  });

  const gridDays = useMemo(
    () =>
      mode === 'month'
        ? computeMonthGridDays(anchor, WEEK_STARTS_ON)
        : computeWeekGridDays(anchor, WEEK_STARTS_ON),
    [anchor, mode],
  );
  const range = useMemo(() => computeVisibleRange(gridDays), [gridDays]);

  // `querySpec` includes `range` (derived from `anchor`/`mode`), so
  // navigating months/weeks produces a new query object -> a new
  // `useObjectsQuery` cache key -> automatic refetch (AC: "sorgu her ay
  // değiştiğinde yeniden tetiklenir").
  const querySpec = useMemo(
    () => computeCalendarQuerySpec(objectType, dateField, range),
    [objectType, dateField, range],
  );
  const mainQuery = useObjectsQuery(workspaceId, querySpec);
  const mutation = useSetFieldValuesMutation(workspaceId);

  const baseObjects = useMemo<ObjectWithFieldValues[]>(
    () =>
      mainQuery.data !== undefined && 'objects' in mainQuery.data ? mainQuery.data.objects : [],
    [mainQuery.data],
  );

  // Per-drag local optimistic override, independent of the shared
  // mutation's own cache-level optimism — mirrors BoardView.tsx's pattern
  // (see its comment for the full rationale: more than one drag can be in
  // flight through the same shared mutation instance, so rollback must be
  // scoped per-call via `onError`, never the mutation's global status).
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const itemsByDay = useMemo(() => {
    const map: Record<string, ObjectWithFieldValues[]> = {};
    if (dateField === undefined) {
      return map;
    }
    for (const object of baseObjects) {
      const day = overrides[object.id] ?? extractISODay(object.fieldValues[dateField]);
      if (day === undefined) {
        continue;
      }
      (map[day] ??= []).push(object);
    }
    return map;
  }, [baseObjects, dateField, overrides]);

  // F1-T12 PR8a — read-only external-calendar sync (ADR-0012 §a/§b): a
  // second, independent pair of queries surfaces external-provider events
  // and pre-computed conflict pairs for the same visible range, purely for
  // display — neither ever feeds back into a mutation.
  const externalEventsQuery = useExternalCalendarEventsQuery(workspaceId, range);
  const conflictsQuery = useCalendarConflictsQuery(workspaceId, range);

  const conflictObjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pair of conflictsQuery.data ?? []) {
      if (pair.a.kind === 'timeblock') {
        ids.add(pair.a.id);
      }
      if (pair.b.kind === 'timeblock') {
        ids.add(pair.b.id);
      }
    }
    return ids;
  }, [conflictsQuery.data]);

  const mergedItemsByDay = useMemo(() => {
    const map: Record<string, CalendarDayItem[]> = {};
    for (const [day, objects] of Object.entries(itemsByDay)) {
      map[day] = objects.map((object) => ({
        kind: 'object' as const,
        object,
        hasConflict: conflictObjectIds.has(object.id),
      }));
    }
    for (const event of externalEventsQuery.data ?? []) {
      const day = extractISODay(event.start);
      if (day === undefined) {
        continue;
      }
      (map[day] ??= []).push({ kind: 'external' as const, event });
    }
    return map;
  }, [itemsByDay, conflictObjectIds, externalEventsQuery.data]);

  const handleDragEnd = (event: DragEndEvent): void => {
    if (dateField === undefined) {
      return;
    }
    const objectId = String(event.active.id);
    if (event.over === null) {
      return;
    }
    const targetDateISO = String(event.over.id);
    const object = baseObjects.find((candidate) => candidate.id === objectId);
    const currentValue = object?.fieldValues[dateField];

    const update = computeDateFieldUpdate(dateField, objectId, currentValue, targetDateISO);
    if (update === null) {
      return;
    }

    setOverrides((prev) => ({ ...prev, [objectId]: targetDateISO }));
    mutation.mutate(update, {
      onError: () => {
        setOverrides((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([key]) => key !== objectId)),
        );
      },
    });
  };

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  const goPrev = (): void => {
    setAnchor((prev) => (mode === 'month' ? addMonths(prev, -1) : addDays(prev, -7)));
  };
  const goNext = (): void => {
    setAnchor((prev) => (mode === 'month' ? addMonths(prev, 1) : addDays(prev, 7)));
  };

  // The bootstrap query alone gates loading/error/empty: it is the only
  // thing standing between "nothing rendered yet" and a usable view (date
  // field selection). The range-scoped `mainQuery` refetches silently on
  // navigation without re-showing a full-page skeleton — same as how
  // Board/Table don't re-block their whole view on a background refetch.
  if (bootstrapQuery.isLoading || (bootstrapQuery.data === undefined && !bootstrapQuery.isError)) {
    return (
      <div data-testid="calendar-view-loading">
        <Skeleton height={40} />
        <Skeleton height={300} />
      </div>
    );
  }

  if (bootstrapQuery.isError) {
    return (
      <EmptyState
        data-testid="calendar-view-error"
        title="Bir hata oluştu"
        description="Nesneler yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  // `dateField === undefined` iff `candidates.length === 0` (its only other
  // source, `selectedDateField`, starts undefined and can only ever be set
  // to a value already present in `candidates`). F1-T12 PR8a: this no longer
  // gates the WHOLE view — a workspace with no internal date-like field but
  // at least one read-only external-calendar event still has something
  // useful to show (the external overlay), so the empty state only fires
  // when there's truly nothing (no date field AND no external events).
  if (dateField === undefined && (externalEventsQuery.data ?? []).length === 0) {
    return (
      <EmptyState
        data-testid="calendar-view-empty"
        title="Tarih alanı bulunamadı"
        description="Takvimde gösterilecek bir tarih/tarih-saat alanı içeren nesne yok."
      />
    );
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <SelectRoot
          {...(dateField !== undefined ? { value: dateField } : {})}
          onValueChange={(next) => {
            setSelectedDateField(next);
          }}
        >
          <SelectTrigger data-testid="calendar-date-field-select" aria-label="Tarih alanı seç">
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

        <TabsRoot
          value={mode}
          onValueChange={(next) => {
            setMode(next as CalendarMode);
          }}
        >
          <TabsList aria-label="Takvim modu">
            <TabsTrigger value="month" data-testid="calendar-mode-tab-month">
              Ay
            </TabsTrigger>
            <TabsTrigger value="week" data-testid="calendar-mode-tab-week">
              Hafta
            </TabsTrigger>
          </TabsList>
        </TabsRoot>

        <Button
          variant="ghost"
          data-testid="calendar-nav-prev"
          aria-label="Önceki"
          onClick={goPrev}
        >
          ◀
        </Button>
        <span className={styles.monthLabel}>{formatMonthLabel(anchor)}</span>
        <Button
          variant="ghost"
          data-testid="calendar-nav-next"
          aria-label="Sonraki"
          onClick={goNext}
        >
          ▶
        </Button>
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <CalendarGrid
          days={gridDays}
          itemsByDay={mergedItemsByDay}
          onDayClick={setCreatingForDate}
        />
      </DndContext>

      {creatingForDate !== undefined && (
        <CreateTimeblockModal
          workspaceId={workspaceId}
          dateISO={creatingForDate}
          onClose={() => {
            setCreatingForDate(undefined);
          }}
        />
      )}
    </div>
  );
}
