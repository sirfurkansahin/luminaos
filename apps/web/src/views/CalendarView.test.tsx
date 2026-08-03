import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { CalendarView } from './CalendarView.js';
import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';
import { addDays, getTodayDateOnly, toISODate } from '../lib/dateMath.js';

import type { OptimisticContext } from '../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';
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

const mockedUseObjectsQuery = vi.mocked(useObjectsQuery);
const mockedUseSetFieldValuesMutation = vi.mocked(useSetFieldValuesMutation);

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
});
