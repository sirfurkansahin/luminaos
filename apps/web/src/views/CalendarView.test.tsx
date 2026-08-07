import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { CalendarView } from './CalendarView.js';
import {
  useCalendarConflictsQuery,
  useExternalCalendarEventsQuery,
} from '../hooks/useCalendarExtras.js';
import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';
import { addDays, getTodayDateOnly, toISODate } from '../lib/dateMath.js';

import type { OptimisticContext } from '../hooks/useObjectsQuery.js';
import type {
  ConflictPair,
  ExternalCalendarEvent,
  ObjectWithFieldValues,
  QueryResult,
} from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Mirrors BoardView.test.tsx's mocking approach: `../hooks/useObjectsQuery.js`
 * and `@dnd-kit/core` are mocked wholesale. `@dnd-kit/core` additionally
 * needs `useDroppable`/`useDraggable` stubs (unlike BoardView's test, this
 * suite lets the real CalendarGrid/CalendarObjectChip render, to verify
 * day-bucketing) since CalendarGrid/CalendarObjectChip call those hooks
 * directly.
 */

interface SyntheticDragEndEvent {
  active: { id: string | number };
  over: { id: string | number } | null;
}

const dndState = vi.hoisted(() => ({
  capturedOnDragEnd: undefined as ((event: SyntheticDragEndEvent) => void) | undefined,
}));

vi.mock('@dnd-kit/core', () => {
  function PointerSensor(): void {
    // intentionally empty — identity/`.name` stand-in only (see BoardView.test.tsx).
  }
  function KeyboardSensor(): void {
    // intentionally empty — identity/`.name` stand-in only (see BoardView.test.tsx).
  }
  return {
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: ReactNode;
      onDragEnd: (event: SyntheticDragEndEvent) => void;
    }) => {
      dndState.capturedOnDragEnd = onDragEnd;
      return children;
    },
    useSensor: vi.fn((sensor: unknown, options?: unknown) => ({ sensor, options })),
    useSensors: vi.fn((...sensors: unknown[]) => sensors),
    useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
    useDraggable: vi.fn(() => ({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      isDragging: false,
    })),
    PointerSensor,
    KeyboardSensor,
  };
});

vi.mock('../hooks/useObjectsQuery.js', () => ({
  useObjectsQuery: vi.fn(),
  useSetFieldValuesMutation: vi.fn(),
}));

/**
 * F1-T12 PR8a addition — mirrors the wholesale-mock convention above for the
 * two new read-only hooks (`useExternalCalendarEventsQuery`/
 * `useCalendarConflictsQuery`, from a not-yet-implemented
 * `../hooks/useCalendarExtras.js`). Defaulted to empty-array `data` in
 * `mockCalendarExtras()`'s no-arg form so every EXISTING test case above
 * (which never calls `mockCalendarExtras()` at all) still renders exactly as
 * before once the implementer wires `CalendarView.tsx` to call these hooks —
 * `undefined` real-hook-return-value mocks would otherwise crash any
 * pre-existing test that doesn't know about this new dependency.
 */
vi.mock('../hooks/useCalendarExtras.js', () => ({
  useExternalCalendarEventsQuery: vi.fn(),
  useCalendarConflictsQuery: vi.fn(),
}));

/**
 * F1-T12 PR8b addition — mirrors ObjectDetailHost.test.tsx's convention of
 * mocking a whole child component wholesale with an inline JSX stub, so this
 * suite can assert CalendarView.tsx's own day-click wiring (which day was
 * clicked, whether the modal was mounted at all) without depending on
 * CreateTimeblockModal.tsx's (not-yet-implemented) internals.
 */
const timeblockModalState = vi.hoisted(() => ({
  lastProps: undefined as { workspaceId: string; dateISO: string; onClose: () => void } | undefined,
}));

vi.mock('./calendar/CreateTimeblockModal.js', () => ({
  CreateTimeblockModal: (props: { workspaceId: string; dateISO: string; onClose: () => void }) => {
    timeblockModalState.lastProps = props;
    return <div data-testid="create-timeblock-modal-mock" data-date={props.dateISO} />;
  },
}));

const mockedUseObjectsQuery = vi.mocked(useObjectsQuery);
const mockedUseSetFieldValuesMutation = vi.mocked(useSetFieldValuesMutation);
const mockedUseExternalCalendarEventsQuery = vi.mocked(useExternalCalendarEventsQuery);
const mockedUseCalendarConflictsQuery = vi.mocked(useCalendarConflictsQuery);

function mockCalendarExtras(
  events: ExternalCalendarEvent[] | undefined = [],
  conflicts: ConflictPair[] | undefined = [],
) {
  mockedUseExternalCalendarEventsQuery.mockReturnValue({
    data: events,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockedUseCalendarConflictsQuery.mockReturnValue({
    data: conflicts,
    isLoading: false,
    isError: false,
    error: null,
  });
}

const workspaceId = 'ws-1';
const objectType = 'task';

function isBootstrapQuerySpec(querySpec: QuerySpec): boolean {
  return querySpec.filters.length === 0;
}

function mockQueries(bootstrap: QueryResult | undefined, main: QueryResult | undefined) {
  mockedUseObjectsQuery.mockImplementation((_workspaceId: string, querySpec: QuerySpec) => {
    const data = isBootstrapQuerySpec(querySpec) ? bootstrap : main;
    return {
      data,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>;
  });
}

type MutateCall = (
  vars: { objectId: string; values: Record<string, unknown> },
  options?: { onError?: () => void },
) => void;

function mockMutation() {
  const mutate = vi.fn<MutateCall>();
  mockedUseSetFieldValuesMutation.mockReturnValue({
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  } as unknown as UseMutationResult<
    { object: ObjectWithFieldValues },
    Error,
    { objectId: string; values: Record<string, unknown> },
    OptimisticContext
  >);
  return mutate;
}

function makeObject(id: string, dueDate: string, title = `Object ${id}`): ObjectWithFieldValues {
  return {
    id,
    title,
    fieldValues: { dueDate },
  } as unknown as ObjectWithFieldValues;
}

beforeEach(() => {
  dndState.capturedOnDragEnd = undefined;
  // Default every pre-existing test (none of which know about these new F1-T12
  // PR8a hooks) to empty-array data, so they keep rendering exactly as before
  // once CalendarView.tsx is wired to call them — a test can still override
  // via its own `mockCalendarExtras(...)` call for the new coverage below.
  mockCalendarExtras();
  // F1-T12 PR8b addition — resets the mocked CreateTimeblockModal's captured
  // props between tests so a stale value from a previous test can't leak in.
  timeblockModalState.lastProps = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CalendarView', () => {
  it('renders a loading state (data-testid="calendar-view-loading") while the bootstrap query is loading', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);
    mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('calendar-view-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="calendar-view-error") when the bootstrap query isError', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    } as unknown as UseQueryResult<QueryResult>);
    mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('calendar-view-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="calendar-view-empty") when no date-like field is found', () => {
    mockQueries(
      {
        objects: [
          { id: 'o1', title: 'X', fieldValues: { title: 'X' } } as unknown as ObjectWithFieldValues,
        ],
      },
      undefined,
    );
    mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('calendar-view-empty')).toBeInTheDocument();
  });

  it("renders an object's date value in the correct day cell", () => {
    const today = toISODate(getTodayDateOnly());
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    const cell = screen
      .getAllByTestId('calendar-day-cell')
      .find((element) => element.getAttribute('data-date') === today);
    expect(cell).toBeDefined();
    const chip = screen.getByTestId('calendar-object-chip');
    expect(cell as HTMLElement).toContainElement(chip);
    expect(chip).toHaveTextContent('Object obj-1');
  });

  it('calling onDragEnd with a different target day calls the mutation with the expected payload', () => {
    const today = toISODate(getTodayDateOnly());
    const targetDay = toISODate(addDays(getTodayDateOnly(), 1));
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    const mutate = mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(dndState.capturedOnDragEnd).toBeDefined();
    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-1' }, over: { id: targetDay } });
    });

    expect(mutate.mock.calls[0]?.[0]).toEqual({
      objectId: 'obj-1',
      values: { dueDate: targetDay },
    });
  });

  it('does not call the mutation when dropped back onto the same day (no-op)', () => {
    const today = toISODate(getTodayDateOnly());
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    const mutate = mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-1' }, over: { id: today } });
    });

    expect(mutate).not.toHaveBeenCalled();
  });

  it('renders the date-field select with the detected field as its accessible combobox', () => {
    const today = toISODate(getTodayDateOnly());
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('calendar-date-field-select')).toBeInTheDocument();
  });

  /**
   * F1-T9 PR2 addition: an optional `initialDateField` prop seeds the
   * initially-selected date field (used to restore a saved view's stored
   * `dateField` instead of always defaulting to `candidates[0]`). Two
   * distinct date-like candidates are seeded here (`completedAt`/`dueDate`,
   * alphabetically `completedAt` < `dueDate`) so the default
   * (`candidates[0]` === 'completedAt') and an explicit `initialDateField`
   * (`'dueDate'`) are observably different.
   */
  function makeTwoFieldObject(id: string): ObjectWithFieldValues {
    return {
      id,
      title: `Object ${id}`,
      fieldValues: { completedAt: '2026-01-01', dueDate: '2026-01-05' },
    } as unknown as ObjectWithFieldValues;
  }

  it("regression: with no initialDateField prop, defaults to candidates[0] (today's exact default behavior)", () => {
    const obj = makeTwoFieldObject('obj-1');
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    const lastCall = mockedUseObjectsQuery.mock.calls[mockedUseObjectsQuery.mock.calls.length - 1];
    const querySpec = lastCall?.[1] as QuerySpec;
    expect(querySpec.filters[0]?.field).toBe('completedAt');
  });

  it('seeds the initially-selected date field from an initialDateField prop instead of candidates[0]', () => {
    const obj = makeTwoFieldObject('obj-1');
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();

    render(
      <CalendarView workspaceId={workspaceId} objectType={objectType} initialDateField="dueDate" />,
    );

    const lastCall = mockedUseObjectsQuery.mock.calls[mockedUseObjectsQuery.mock.calls.length - 1];
    const querySpec = lastCall?.[1] as QuerySpec;
    expect(querySpec.filters[0]?.field).toBe('dueDate');
    expect(screen.getByTestId('calendar-date-field-select')).toHaveTextContent('dueDate');
  });
});

/**
 * F1-T12 PR8a — TDD red step. New coverage for the read-only external-events/
 * conflicts merge logic CalendarView.tsx must grow (per the pinned contract):
 *   - `useExternalCalendarEventsQuery`/`useCalendarConflictsQuery` (both from
 *     a not-yet-implemented `../hooks/useCalendarExtras.js`, mocked wholesale
 *     above) are called with `(workspaceId, computeVisibleRange(gridDays))`.
 *   - Each returned `ExternalCalendarEvent` is bucketed into the grid day
 *     matching its `start`'s ISO date and rendered as an
 *     `ExternalEventChip`/`data-testid="external-event-chip"`.
 *   - Any object whose id appears as either `a` or `b` of any
 *     `ConflictPair` with `kind === 'timeblock'` renders its
 *     `CalendarObjectChip` with `hasConflict` -> `data-testid="conflict-badge"`
 *     visible; objects absent from every pair do not show it.
 *   - Missing/undefined query data for either hook must not crash the view
 *     and must not fabricate phantom chips (safe merge with defaults).
 */
describe('CalendarView — external events & conflicts (F1-T12 PR8a)', () => {
  it("renders an external event as an external-event-chip bucketed into its start date's day cell", () => {
    const today = toISODate(getTodayDateOnly());
    mockQueries({ objects: [] }, { objects: [] });
    mockMutation();
    mockCalendarExtras([
      {
        externalId: 'ext-1',
        title: 'Doktor randevusu',
        start: `${today}T10:00:00.000Z`,
        end: `${today}T10:30:00.000Z`,
      },
    ]);

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    const cell = screen
      .getAllByTestId('calendar-day-cell')
      .find((element) => element.getAttribute('data-date') === today);
    expect(cell).toBeDefined();
    const chip = screen.getByTestId('external-event-chip');
    expect(cell as HTMLElement).toContainElement(chip);
    expect(chip).toHaveTextContent('Doktor randevusu');
  });

  it('renders a conflict badge on the CalendarObjectChip of an object referenced by a timeblock conflict pair, and not on an unrelated object', () => {
    const today = toISODate(getTodayDateOnly());
    const conflicted = makeObject('obj-conflicted', today);
    const clean = makeObject('obj-clean', today);
    mockQueries({ objects: [conflicted, clean] }, { objects: [conflicted, clean] });
    mockMutation();
    mockCalendarExtras(
      [],
      [
        {
          a: {
            kind: 'timeblock',
            id: 'obj-conflicted',
            title: 'Object obj-conflicted',
            start: `${today}T09:00:00.000Z`,
            end: `${today}T11:00:00.000Z`,
          },
          b: {
            kind: 'external',
            id: 'ext-1',
            title: 'Doktor randevusu',
            start: `${today}T10:00:00.000Z`,
            end: `${today}T10:30:00.000Z`,
          },
        },
      ],
    );

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    const chips = screen.getAllByTestId('calendar-object-chip');
    const conflictedChip = chips.find((chip) => chip.textContent.includes('obj-conflicted'));
    const cleanChip = chips.find((chip) => chip.textContent.includes('obj-clean'));
    expect(conflictedChip).toBeDefined();
    expect(cleanChip).toBeDefined();
    expect(conflictedChip as HTMLElement).toContainElement(screen.getByTestId('conflict-badge'));
    expect(
      cleanChip !== undefined && cleanChip.querySelector('[data-testid="conflict-badge"]'),
    ).toBeNull();
  });

  it('regression: renders exactly as before (no crash, no phantom chips) when both new queries return undefined data', () => {
    const today = toISODate(getTodayDateOnly());
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();
    mockCalendarExtras(undefined, undefined);

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.queryByTestId('external-event-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conflict-badge')).not.toBeInTheDocument();
    const chip = screen.getByTestId('calendar-object-chip');
    expect(chip).toHaveTextContent('Object obj-1');
  });
});

/**
 * F1-T12 PR8b — TDD red step. New coverage for the click-day-to-create-
 * timeblock flow (the deliberately-not-pixel-precise-drag substitute — see
 * docs/specs/F1-E3/F1-T12-takvim.md's "Kapsam DIŞI" note). Per the pinned
 * contract:
 *   - CalendarView.tsx owns `creatingForDate` state and passes
 *     `onDayClick={setCreatingForDate}` down to CalendarGrid.
 *   - Clicking an EMPTY day cell's background calls that callback with the
 *     cell's ISO date, which mounts `CreateTimeblockModal` (mocked wholesale
 *     above) with that `dateISO`.
 *   - Clicking a CHIP inside a day cell must NOT trigger the day-click
 *     handler (regression proof that chip drag/click interactions aren't
 *     hijacked by the new day-level handler).
 */
describe('CalendarView — click day to create a timeblock (F1-T12 PR8b)', () => {
  it("clicking an empty day cell's background opens CreateTimeblockModal with that cell's dateISO", async () => {
    const today = toISODate(getTodayDateOnly());
    const emptyDay = toISODate(addDays(getTodayDateOnly(), 3));
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();
    const user = userEvent.setup();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.queryByTestId('create-timeblock-modal-mock')).not.toBeInTheDocument();

    const emptyCell = screen
      .getAllByTestId('calendar-day-cell')
      .find((element) => element.getAttribute('data-date') === emptyDay);
    if (emptyCell === undefined) {
      throw new Error(`expected to find a calendar-day-cell for ${emptyDay}`);
    }

    await user.click(emptyCell);

    const modal = screen.getByTestId('create-timeblock-modal-mock');
    expect(modal).toBeInTheDocument();
    expect(modal.getAttribute('data-date')).toBe(emptyDay);
    expect(timeblockModalState.lastProps?.dateISO).toBe(emptyDay);
    expect(timeblockModalState.lastProps?.workspaceId).toBe(workspaceId);
  });

  it('clicking a chip inside a day cell does NOT open the create-timeblock modal', async () => {
    const today = toISODate(getTodayDateOnly());
    const obj = makeObject('obj-1', today);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    mockMutation();
    const user = userEvent.setup();

    render(<CalendarView workspaceId={workspaceId} objectType={objectType} />);

    const chip = screen.getByTestId('calendar-object-chip');
    await user.click(chip);

    expect(screen.queryByTestId('create-timeblock-modal-mock')).not.toBeInTheDocument();
  });
});
