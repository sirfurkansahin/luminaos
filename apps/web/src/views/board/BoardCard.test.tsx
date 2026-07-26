import { useDraggable } from '@dnd-kit/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BoardCard } from './BoardCard.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/board/BoardCard.tsx to satisfy these tests, and add
 * `@dnd-kit/core` as a runtime dependency of apps/web/package.json — neither
 * is there yet, so this file's imports will fail to resolve until then.
 * That's the expected TDD red state.):
 *
 *   export interface BoardCardProps {
 *     object: ObjectWithFieldValues;
 *   }
 *   export function BoardCard(props: BoardCardProps): React.JSX.Element;
 *
 * Internally calls `useDraggable({ id: object.id })` from `@dnd-kit/core`
 * (mocked wholesale below — real dnd-kit sensor/collision logic is out of
 * scope here) and renders `object.title`. Root element is discoverable via
 * data-testid="board-card".
 */

vi.mock('@dnd-kit/core', () => ({
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  })),
}));

const mockedUseDraggable = vi.mocked(useDraggable);

function makeObject(overrides: Partial<ObjectWithFieldValues> = {}): ObjectWithFieldValues {
  return {
    id: 'obj-1',
    type: 'task',
    workspaceId: 'ws-1',
    title: 'Design the board view',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    lifecycle: 'active',
    fieldValues: { status: 'todo' },
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

describe('BoardCard', () => {
  it("renders the object's title", () => {
    render(<BoardCard object={makeObject({ title: 'Design the board view' })} />);

    expect(screen.getByText('Design the board view')).toBeInTheDocument();
  });

  it('renders a root element with data-testid="board-card"', () => {
    render(<BoardCard object={makeObject()} />);

    expect(screen.getByTestId('board-card')).toBeInTheDocument();
  });

  it('calls useDraggable with the object id', () => {
    const object = makeObject({ id: 'obj-42' });
    render(<BoardCard object={object} />);

    expect(mockedUseDraggable).toHaveBeenCalledWith(expect.objectContaining({ id: 'obj-42' }));
  });
});
