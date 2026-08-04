import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { TableView } from './TableView.js';
import { useObjectIdParam } from '../hooks/useObjectIdParam.js';
import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';

import type { OptimisticContext } from '../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/TableView.tsx (and apps/web/src/views/table/EditableCell.tsx,
 * pinned separately by apps/web/src/views/table/EditableCell.test.tsx) to
 * satisfy these tests. That's the expected TDD red state.):
 *
 *   export interface TableViewProps {
 *     workspaceId: string;
 *     querySpec: QuerySpec;
 *   }
 *   export function TableView(props: TableViewProps): React.JSX.Element;
 *
 * Internally calls `useObjectsQuery(workspaceId, querySpec)` and
 * `useSetFieldValuesMutation(workspaceId)` (../hooks/useObjectsQuery.ts,
 * pinned separately — mocked wholesale here). Renders one of four states,
 * mirroring ListView's testid convention but under the `table-view-*` prefix:
 *
 *   - isLoading: true             -> data-testid="table-view-loading"
 *   - isError: true               -> data-testid="table-view-error"
 *   - data.objects.length === 0   -> data-testid="table-view-empty"
 *   - data.objects.length > 0     -> a table: one data-testid="table-row" per
 *                                    object, and inside each row one
 *                                    data-testid="table-cell" per
 *                                    `Object.keys(object.fieldValues)` entry
 *                                    (in that key order). Each cell renders
 *                                    its value via
 *                                    apps/web/src/views/table/EditableCell.tsx
 *                                    (display text initially, an
 *                                    data-testid="editable-cell-input" once
 *                                    clicked into edit mode). The cell wrapper
 *                                    itself (data-testid="table-cell") is
 *                                    independently focusable (tabIndex=0) so
 *                                    that arrow-key navigation (see below)
 *                                    works even while its inner EditableCell
 *                                    is in read-only mode.
 *
 * Keyboard navigation (chosen pattern — implementer follows this, Tab is
 * left to default browser behavior and is NOT overridden): while a
 * `table-cell` wrapper has DOM focus, ArrowRight/ArrowLeft move focus to the
 * next/previous cell in the same row (wrapping across row boundaries is NOT
 * required), and ArrowDown/ArrowUp move focus to the cell directly
 * below/above in the same column index. Cells are ordered row-major, so with
 * `columnCount` fields per row, the cell at flat index `i` sits at
 * `(row = Math.floor(i / columnCount), col = i % columnCount)`.
 *
 * Committing an edit: EditableCell's `onCommit(newValue)` for the cell at
 * (object, fieldKey) calls `useSetFieldValuesMutation(workspaceId).mutate`
 * with `{ objectId: object.id, values: { [fieldKey]: newValue } }`. The
 * actual optimistic-update/invalidation behavior of the mutation itself is
 * pinned by apps/web/src/hooks/useObjectsQuery.test.ts — this file only
 * checks TableView calls `mutate` with the right arguments.
 *
 * F1-T10 PR6c addition: each row also gets a NEW, dedicated non-editable
 * title cell — data-testid="table-title-cell" — rendered as the FIRST cell
 * of the row, distinct from (and NOT counted among) the per-fieldValue
 * data-testid="table-cell"/EditableCell cells above. Design reasoning (see
 * this file's header comment for the general TableView contract): the whole
 * row can't be made clickable because each fieldValue cell already owns its
 * own click-to-edit interaction (EditableCell) — a row-level click handler
 * would fight that. TableView didn't previously render a title column at
 * all, so adding one dedicated, read-only, keyboard-accessible
 * (`role="button" tabIndex={0}`, mirroring EditableCell.tsx's display-span
 * convention) cell is a non-conflicting affordance. It is NOT part of the
 * ArrowRight/Left/Up/Down grid-navigation cell set (that navigation is
 * scoped to the per-fieldValue `table-cell`s only, unchanged from before).
 * Clicking or pressing Enter on it calls `openObject(object.id)` from the
 * newly-mocked `useObjectIdParam.ts` (../hooks/useObjectIdParam.ts).
 */

function makeObjects(): ObjectWithFieldValues[] {
  return [
    {
      id: 'obj-1',
      title: 'Object 1',
      fieldValues: { status: 'todo', priority: 'low' },
    },
    {
      id: 'obj-2',
      title: 'Object 2',
      fieldValues: { status: 'done', priority: 'high' },
    },
    {
      id: 'obj-3',
      title: 'Object 3',
      fieldValues: { status: 'todo', priority: 'medium' },
    },
  ] as unknown as ObjectWithFieldValues[];
}

vi.mock('../hooks/useObjectsQuery.js', () => ({
  useObjectsQuery: vi.fn(),
  useSetFieldValuesMutation: vi.fn(),
}));

// F1-T10 PR6c: TableView now also reads `openObject` from
// useObjectIdParam.ts (mocked wholesale, mirroring useObjectsQuery.js above)
// so a new, dedicated non-editable title column can open the detail panel —
// see the "opens the detail panel" describe block below. This is an ADDED
// dependency; every existing test above must keep passing unchanged, so a
// default (objectId: undefined) mock return is wired in beforeEach via
// mockOpenObject().
vi.mock('../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

const mockedUseObjectsQuery = vi.mocked(useObjectsQuery);
const mockedUseSetFieldValuesMutation = vi.mocked(useSetFieldValuesMutation);
const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);

const workspaceId = 'ws-1';
const querySpec: QuerySpec = { objectType: 'task', filters: [] };

function mockMutate() {
  const mutate = vi.fn();
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

function mockOpenObject() {
  const openObject = vi.fn();
  mockedUseObjectIdParam.mockReturnValue({
    objectId: undefined,
    openObject,
    closeObject: vi.fn(),
  });
  return openObject;
}

beforeEach(() => {
  mockMutate();
  mockOpenObject();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TableView', () => {
  it('renders a loading state (data-testid="table-view-loading") while the query is loading', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('table-view-loading')).toBeInTheDocument();
    expect(screen.queryAllByTestId('table-row')).toHaveLength(0);
  });

  it('renders an error state (data-testid="table-view-error") when the query isError', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    } as unknown as UseQueryResult<QueryResult>);

    render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('table-view-error')).toBeInTheDocument();
    expect(screen.queryAllByTestId('table-row')).toHaveLength(0);
  });

  it('renders an empty state (data-testid="table-view-empty") when the query resolves with zero objects', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: { objects: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('table-view-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('table-row')).toHaveLength(0);
  });

  it('renders one table-row per object and one table-cell per fieldValues key', () => {
    const objects = makeObjects();
    mockedUseObjectsQuery.mockReturnValue({
      data: { objects },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

    const rows = screen.getAllByTestId('table-row');
    expect(rows).toHaveLength(3);

    const cells = screen.getAllByTestId('table-cell');
    // 3 objects * 2 fieldValues keys (status, priority) each = 6 cells.
    expect(cells).toHaveLength(6);

    const displays = screen.getAllByTestId('editable-cell-display');
    const displayedText = displays.map((el) => el.textContent).join('|');
    expect(displayedText).toContain('todo');
    expect(displayedText).toContain('done');
    expect(displayedText).toContain('low');
    expect(displayedText).toContain('high');
    expect(displayedText).toContain('medium');
  });

  it('moves focus between table-cell elements with arrow keys (row-major grid navigation)', async () => {
    const user = userEvent.setup();
    const objects = makeObjects();
    mockedUseObjectsQuery.mockReturnValue({
      data: { objects },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

    const cells = screen.getAllByTestId('table-cell');
    // Row-major, columnCount = 2 (status, priority):
    //   index 0 = (row 0, col 0) "status" of obj-1
    //   index 1 = (row 0, col 1) "priority" of obj-1
    //   index 2 = (row 1, col 0) "status" of obj-2
    //   index 3 = (row 1, col 1) "priority" of obj-2
    cells[0]?.focus();
    expect(document.activeElement).toBe(cells[0]);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(cells[1]);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(cells[3]);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(cells[2]);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(cells[0]);
  });

  it('calls useSetFieldValuesMutation().mutate with {objectId, values} when a cell edit is committed', async () => {
    const mutate = mockMutate();
    const user = userEvent.setup();
    const objects = makeObjects();
    mockedUseObjectsQuery.mockReturnValue({
      data: { objects },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

    // First cell (obj-1's "status" field, currently "todo").
    const firstDisplay = screen.getAllByTestId('editable-cell-display')[0];
    if (firstDisplay === undefined) {
      throw new Error('expected at least one editable-cell-display');
    }
    await user.click(firstDisplay);

    const firstInput = screen.getAllByTestId('editable-cell-input')[0];
    if (firstInput === undefined) {
      throw new Error('expected an editable-cell-input after entering edit mode');
    }
    await user.clear(firstInput);
    await user.type(firstInput, 'in-progress{Enter}');

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        objectId: 'obj-1',
        values: { status: 'in-progress' },
      });
    });
  });

  describe('opens the detail panel via the title cell', () => {
    it('renders one table-title-cell per row, distinct from the fieldValue table-cells', () => {
      const objects = makeObjects();
      mockedUseObjectsQuery.mockReturnValue({
        data: { objects },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as UseQueryResult<QueryResult>);

      render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

      const titleCells = screen.getAllByTestId('table-title-cell');
      expect(titleCells).toHaveLength(3);
      // Still exactly 6 fieldValue cells (3 objects * 2 keys) — the new
      // title cell does NOT get counted as a "table-cell".
      expect(screen.getAllByTestId('table-cell')).toHaveLength(6);
      expect(titleCells.map((cell) => cell.textContent)).toEqual([
        'Object 1',
        'Object 2',
        'Object 3',
      ]);
    });

    it('calls openObject(object.id) when a row title cell is clicked', async () => {
      const openObject = mockOpenObject();
      const user = userEvent.setup();
      const objects = makeObjects();
      mockedUseObjectsQuery.mockReturnValue({
        data: { objects },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as UseQueryResult<QueryResult>);

      render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

      const titleCells = screen.getAllByTestId('table-title-cell');
      const secondTitleCell = titleCells[1];
      if (secondTitleCell === undefined) {
        throw new Error('expected at least two table-title-cell elements');
      }
      await user.click(secondTitleCell);

      expect(openObject).toHaveBeenCalledWith('obj-2');
    });

    it('calls openObject(object.id) when Enter is pressed on a focused row title cell', async () => {
      const openObject = mockOpenObject();
      const user = userEvent.setup();
      const objects = makeObjects();
      mockedUseObjectsQuery.mockReturnValue({
        data: { objects },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as UseQueryResult<QueryResult>);

      render(<TableView workspaceId={workspaceId} querySpec={querySpec} />);

      const firstTitleCell = screen.getAllByTestId('table-title-cell')[0];
      if (firstTitleCell === undefined) {
        throw new Error('expected at least one table-title-cell element');
      }
      firstTitleCell.focus();
      await user.keyboard('{Enter}');

      expect(openObject).toHaveBeenCalledWith('obj-1');
    });
  });
});
