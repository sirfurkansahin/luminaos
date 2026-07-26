import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { BoardView } from './BoardView.js';
import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';

import type { OptimisticContext } from '../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/BoardView.tsx to satisfy these tests. That's the
 * expected TDD red state.):
 *
 *   export interface BoardViewProps {
 *     workspaceId: string;
 *     querySpec: QuerySpec; // querySpec.group is the group-by field key
 *   }
 *   export function BoardView(props: BoardViewProps): React.JSX.Element;
 *
 * Internally calls `useObjectsQuery(workspaceId, querySpec)` and
 * `useSetFieldValuesMutation(workspaceId)` (../hooks/useObjectsQuery.ts,
 * mocked wholesale here — this file does not re-test the mutation's own
 * optimistic/rollback internals, only that BoardView calls `mutate` with the
 * right arguments and reacts to `isError`).
 *
 * Renders one of four states, mirroring ListView/TableView's testid
 * convention under the `board-view-*` prefix:
 *   - isLoading: true                -> data-testid="board-view-loading"
 *   - isError: true                  -> data-testid="board-view-error"
 *   - data.groups.length === 0       -> data-testid="board-view-empty"
 *   - otherwise                      -> a `@dnd-kit/core` DndContext wrapping
 *                                       one `BoardColumn` (../board/BoardColumn.js,
 *                                       pinned separately, mocked wholesale
 *                                       here as a stub rendering
 *                                       data-testid="board-column" +
 *                                       data-group-value={groupValue} +
 *                                       items.length) per group.
 *
 * Drag-and-drop wiring: BoardView keeps its own local
 * `Record<objectId, groupValue>` "override" state (independent of the shared
 * mutation's own optimistic cache, which only knows the flat `{ objects }`
 * query shape, not `{ groups }`). DndContext's `onDragEnd` handler: finds the
 * dragged object's current group (base group, adjusted by any existing
 * override), calls the already-independently-tested pure
 * `computeFieldUpdate(groupField, objectId, sourceGroupValue, event.over?.id)`
 * (../board/dragEndUpdate.ts); if non-null, (a) sets the override so the card
 * visually jumps to the target column immediately, and (b) calls
 * `mutate({ objectId, values })`. If the mutation surfaces `isError: true`,
 * the override for that object is cleared (card snaps back).
 *
 * `@dnd-kit/core` is mocked wholesale: `DndContext` is a passthrough stub
 * that (a) renders `children` and (b) captures its `onDragEnd` and `sensors`
 * props into module-level refs so tests can invoke a synthetic
 * `DragEndEvent` directly and inspect what sensors were wired in, without
 * simulating real pointer/keyboard events (jsdom has no real layout engine,
 * so real dnd-kit collision detection is not exercisable in this
 * environment — this synthetic-event pattern is the accepted community
 * approach for testing dnd-kit consumers).
 */

interface SyntheticDragEndEvent {
  active: { id: string | number };
  over: { id: string | number } | null;
}

const dndState = vi.hoisted(() => ({
  capturedOnDragEnd: undefined as ((event: SyntheticDragEndEvent) => void) | undefined,
  capturedSensors: undefined as unknown[] | undefined,
}));

vi.mock('@dnd-kit/core', () => {
  // Plain named functions stand in for dnd-kit's real `PointerSensor` /
  // `KeyboardSensor` classes — only referential identity and `.name` are
  // exercised by these tests (never `new`'d), and functions avoid the
  // `no-extraneous-class` lint error an intentionally-empty class would
  // trigger.
  function PointerSensor(): void {
    // intentionally empty — identity/`.name` stand-in only, see comment above.
  }
  function KeyboardSensor(): void {
    // intentionally empty — identity/`.name` stand-in only, see comment above.
  }
  return {
    DndContext: ({
      children,
      onDragEnd,
      sensors,
    }: {
      children: ReactNode;
      onDragEnd: (event: SyntheticDragEndEvent) => void;
      sensors: unknown[];
    }) => {
      dndState.capturedOnDragEnd = onDragEnd;
      dndState.capturedSensors = sensors;
      return children;
    },
    useSensor: vi.fn((sensor: unknown, options?: unknown) => ({ sensor, options })),
    useSensors: vi.fn((...sensors: unknown[]) => sensors),
    PointerSensor,
    KeyboardSensor,
  };
});

vi.mock('./board/BoardColumn.js', () => ({
  BoardColumn: ({ groupValue, items }: { groupValue: string; items: ObjectWithFieldValues[] }) => (
    <div data-testid="board-column" data-group-value={groupValue}>
      {items.length}
    </div>
  ),
}));

vi.mock('../hooks/useObjectsQuery.js', () => ({
  useObjectsQuery: vi.fn(),
  useSetFieldValuesMutation: vi.fn(),
}));

const mockedUseObjectsQuery = vi.mocked(useObjectsQuery);
const mockedUseSetFieldValuesMutation = vi.mocked(useSetFieldValuesMutation);

const workspaceId = 'ws-1';
const querySpec: QuerySpec = { objectType: 'task', filters: [], group: 'status' };

function makeObject(id: string, status: string, title = `Object ${id}`): ObjectWithFieldValues {
  return {
    id,
    title,
    fieldValues: { status },
  } as unknown as ObjectWithFieldValues;
}

const obj1 = makeObject('obj-1', 'todo');
const obj2 = makeObject('obj-2', 'done');
const obj3 = makeObject('obj-3', 'todo');

function makeGroups(): QueryResult {
  return {
    groups: [
      { groupValue: 'todo', count: 2, items: [obj1, obj3] },
      { groupValue: 'done', count: 1, items: [obj2] },
    ],
  };
}

type MutateCall = (
  vars: { objectId: string; values: Record<string, unknown> },
  options?: { onError?: () => void },
) => void;

function mockMutation(
  overrides: Partial<
    UseMutationResult<
      { object: ObjectWithFieldValues },
      Error,
      { objectId: string; values: Record<string, unknown> },
      OptimisticContext
    >
  > = {},
) {
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
    ...overrides,
  } as unknown as UseMutationResult<
    { object: ObjectWithFieldValues },
    Error,
    { objectId: string; values: Record<string, unknown> },
    OptimisticContext
  >);
  return mutate;
}

beforeEach(() => {
  dndState.capturedOnDragEnd = undefined;
  dndState.capturedSensors = undefined;
  mockMutation();
});

afterEach(() => {
  vi.clearAllMocks();
});

function getColumn(groupValue: string): HTMLElement {
  const column = screen
    .getAllByTestId('board-column')
    .find((el) => el.getAttribute('data-group-value') === groupValue);
  expect(column).toBeDefined();
  return column as HTMLElement;
}

interface SensorDescriptorLike {
  sensor: unknown;
}

function isSensorDescriptorLike(value: unknown): value is SensorDescriptorLike {
  return typeof value === 'object' && value !== null && 'sensor' in value;
}

function sensorName(value: unknown): string | undefined {
  if (!isSensorDescriptorLike(value)) {
    return undefined;
  }
  return typeof value.sensor === 'function' ? value.sensor.name : undefined;
}

describe('BoardView', () => {
  it('renders a loading state (data-testid="board-view-loading") while the query is loading', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('board-view-loading')).toBeInTheDocument();
    expect(screen.queryAllByTestId('board-column')).toHaveLength(0);
  });

  it('renders an error state (data-testid="board-view-error") when the query isError', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    } as unknown as UseQueryResult<QueryResult>);

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('board-view-error')).toBeInTheDocument();
    expect(screen.queryAllByTestId('board-column')).toHaveLength(0);
  });

  it('renders an empty state (data-testid="board-view-empty") when the query resolves with zero groups', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: { groups: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('board-view-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('board-column')).toHaveLength(0);
  });

  it('renders one board-column per group, each with the correct item count', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: makeGroups(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    const columns = screen.getAllByTestId('board-column');
    expect(columns).toHaveLength(2);
    expect(getColumn('todo').textContent).toBe('2');
    expect(getColumn('done').textContent).toBe('1');
  });

  it('optimistically moves the card and calls mutate when dropped into a different column', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: makeGroups(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);
    const mutate = mockMutation();

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(dndState.capturedOnDragEnd).toBeDefined();
    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-1' }, over: { id: 'done' } });
    });

    // BoardView passes a per-call `onError` (scoped rollback — see security
    // finding in BoardView.tsx's comment) alongside the mutation payload, so
    // only the first (payload) argument is pinned here.
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      objectId: 'obj-1',
      values: { status: 'done' },
    });
    // optimistic: obj-1 moved out of "todo" (2 -> 1) and into "done" (1 -> 2)
    expect(getColumn('todo').textContent).toBe('1');
    expect(getColumn('done').textContent).toBe('2');
  });

  it('does not call mutate when the card is dropped back into its source column', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: makeGroups(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);
    const mutate = mockMutation();

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-1' }, over: { id: 'todo' } });
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(getColumn('todo').textContent).toBe('2');
    expect(getColumn('done').textContent).toBe('1');
  });

  it('rolls back the optimistic move (card returns to its source column) when that specific drag errors', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: makeGroups(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);
    const mutate = mockMutation();

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-1' }, over: { id: 'done' } });
    });
    expect(getColumn('done').textContent).toBe('2');

    // Rollback is scoped per-drag via `mutate`'s own per-call `onError`
    // callback (not the shared mutation's global `isError`) — see
    // BoardView.tsx's comment: a second, unrelated drag can be in flight
    // through the same mutation instance, so a global-status-based rollback
    // would incorrectly revert it too. Invoke exactly the callback this
    // drag's `mutate` call received.
    const onError = mutate.mock.calls[0]?.[1]?.onError;
    expect(onError).toBeDefined();
    act(() => {
      onError?.();
    });

    expect(getColumn('todo').textContent).toBe('2');
    expect(getColumn('done').textContent).toBe('1');
  });

  it('does not roll back an unrelated card when a different drag errors (no shared-mutation cross-talk)', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: makeGroups(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);
    const mutate = mockMutation();

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    // Drag obj-1 (todo -> done), then obj-2 (done -> todo) before the first
    // settles — both share the same `mutation` instance.
    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-1' }, over: { id: 'done' } });
    });
    act(() => {
      dndState.capturedOnDragEnd?.({ active: { id: 'obj-2' }, over: { id: 'todo' } });
    });
    // todo: obj-3 + obj-2 (2), done: obj-1 (1)
    expect(getColumn('todo').textContent).toBe('2');
    expect(getColumn('done').textContent).toBe('1');

    // Only obj-1's drag fails. obj-2's optimistic move must survive.
    const obj1OnError = mutate.mock.calls[0]?.[1]?.onError;
    act(() => {
      obj1OnError?.();
    });

    // obj-1 reverted to "todo"; obj-2 stays in "todo" too (its own move was
    // never rolled back) -> todo has obj-3 + obj-2 + obj-1 (3), done empty.
    expect(getColumn('todo').textContent).toBe('3');
    expect(getColumn('done').textContent).toBe('0');
  });

  it('wires a KeyboardSensor into DndContext (keyboard drag-and-drop accessibility contract)', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: makeGroups(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);
    mockMutation();

    render(<BoardView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(dndState.capturedSensors).toBeDefined();
    const sensors = dndState.capturedSensors ?? [];
    expect(sensors.some((sensor) => sensorName(sensor) === 'KeyboardSensor')).toBe(true);
  });
});
