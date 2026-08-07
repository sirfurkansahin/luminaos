import { useQuery } from '@tanstack/react-query';

import { listCalendarConflicts, listExternalCalendarEvents } from '../lib/apiClient.js';

import type { ConflictPair, ExternalCalendarEvent } from '../lib/apiClient.js';

// F1-T12 PR8a — read-only external-calendar sync (ADR-0012 §a/§b): both
// hooks mirror useObjectsQuery.ts's plain `useQuery` wrapping convention.
//
// A deliberately narrower shape than the full `UseQueryResult<T>`
// discriminated union — mirrors `ObjectQueryResult` in useObjectsQuery.ts:
// CalendarView.test.tsx's `vi.mock` of these hooks returns plain
// `{ data, isLoading, isError, error }` object literals without casting
// them, so `vi.mocked(...).mockReturnValue(...)`'s inferred parameter type
// must structurally accept exactly that. The real runtime value (react-
// query's actual `UseQueryResult`) always has strictly more properties than
// this interface requires, so no cast is needed on the `return` side either.
export interface CalendarExtrasQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export function useExternalCalendarEventsQuery(
  workspaceId: string,
  range: { start: string; end: string },
): CalendarExtrasQueryResult<ExternalCalendarEvent[]> {
  return useQuery({
    queryKey: ['calendar-external-events', workspaceId, range.start, range.end],
    queryFn: () => listExternalCalendarEvents(workspaceId, range),
  });
}

export function useCalendarConflictsQuery(
  workspaceId: string,
  range: { start: string; end: string },
): CalendarExtrasQueryResult<ConflictPair[]> {
  return useQuery({
    queryKey: ['calendar-conflicts', workspaceId, range.start, range.end],
    queryFn: () => listCalendarConflicts(workspaceId, range),
  });
}
