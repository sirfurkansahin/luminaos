import { useDroppable } from '@dnd-kit/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BoardColumn } from './BoardColumn.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/board/BoardColumn.tsx to satisfy these tests, and add
 * `@dnd-kit/core` as a runtime dependency of apps/web/package.json — neither
 * is there yet, so this file's imports will fail to resolve until then.
 * That's the expected TDD red state.):
 *
 *   export interface BoardColumnProps {
 *     groupValue: string;
 *     items: ObjectWithFieldValues[];
 *   }
 *   export function BoardColumn(props: BoardColumnProps): React.JSX.Element;
 *
 * Internally calls `useDroppable({ id: groupValue })` from `@dnd-kit/core`
 * (mocked wholesale below) and renders:
 *   - a root element discoverable via data-testid="board-column"
 *   - `groupValue` as a heading/title
 *   - `items.length` as a counter (e.g. "3" is visible somewhere)
 *   - one `BoardCard` (data-testid="board-card") per item in `items`
 *
 * `BoardCard` itself pulls in `@dnd-kit/core`'s `useDraggable`, which is
 * mocked below alongside `useDroppable` so this file exercises only
 * BoardColumn's own render/composition logic.
 */

vi.mock('@dnd-kit/core', () => ({
  useDroppable: vi.fn(() => ({
    setNodeRef: vi.fn(),
    isOver: false,
  })),
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  })),
}));

const mockedUseDroppable = vi.mocked(useDroppable);

function makeObjects(count: number): ObjectWithFieldValues[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `obj-${String(index)}`,
        type: 'task',
        workspaceId: 'ws-1',
        title: `Task ${String(index)}`,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        lifecycle: 'active',
        fieldValues: { status: 'todo' },
      }) as unknown as ObjectWithFieldValues,
  );
}

describe('BoardColumn', () => {
  it('renders a root element with data-testid="board-column"', () => {
    render(<BoardColumn groupValue="todo" items={[]} />);

    expect(screen.getByTestId('board-column')).toBeInTheDocument();
  });

  it('renders groupValue as a heading/title', () => {
    render(<BoardColumn groupValue="in-progress" items={[]} />);

    expect(screen.getByText('in-progress')).toBeInTheDocument();
  });

  it('renders items.length as a counter', () => {
    render(<BoardColumn groupValue="todo" items={makeObjects(3)} />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders one BoardCard per item in items', () => {
    render(<BoardColumn groupValue="todo" items={makeObjects(3)} />);

    expect(screen.getAllByTestId('board-card')).toHaveLength(3);
  });

  it('calls useDroppable with the groupValue as id', () => {
    render(<BoardColumn groupValue="done" items={[]} />);

    expect(mockedUseDroppable).toHaveBeenCalledWith(expect.objectContaining({ id: 'done' }));
  });
});
