import { useDraggable } from '@dnd-kit/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoardCard } from './BoardCard.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';

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
 *
 * F1-T10 PR6c addition — click-to-open design decision: the draggable root
 * `<div data-testid="board-card">` already spreads dnd-kit's `{...attributes}
 * {...listeners}` (drag-and-drop). Putting an `onClick` handler on that SAME
 * element is technically defensible (dnd-kit's `PointerSensor` normally
 * requires pointer movement past an activation-constraint distance before a
 * drag actually starts, so a plain no-movement click should still fire
 * `onClick`) — but it is FRAGILE: it silently depends on sensor config that
 * lives elsewhere (BoardView's DndContext, not this file), and a future
 * activation-constraint tweak could turn every click into an accidental
 * drag-start with no test here to catch it. The safer, simpler choice taken
 * here instead: only the title TEXT becomes its own clickable/focusable
 * sub-element — `data-testid="board-card-title"`, `role="button"
 * tabIndex={0}`, mirroring EditableCell.tsx's display-span convention — while
 * `{...attributes} {...listeners}` stay on the outer `board-card` div
 * exactly as before. This keeps the two interactions (drag vs. open)
 * structurally non-overlapping instead of relying on pointer-movement
 * timing. `openObject` comes from the newly-mocked useObjectIdParam.ts.
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

vi.mock('../../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

const mockedUseDraggable = vi.mocked(useDraggable);
const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);

function mockOpenObject() {
  const openObject = vi.fn();
  mockedUseObjectIdParam.mockReturnValue({
    objectId: undefined,
    openObject,
    closeObject: vi.fn(),
  });
  return openObject;
}

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

// F1-T10 PR6c: BoardCard now also reads `openObject` from
// useObjectIdParam.ts (mocked wholesale above), so every test — including
// the three pre-existing ones below — needs a default mock return wired up
// before render, or BoardCard's destructuring of useObjectIdParam()'s result
// would throw against the bare `vi.fn()` mock's default `undefined` return.
beforeEach(() => {
  mockOpenObject();
});

afterEach(() => {
  vi.clearAllMocks();
});

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

  describe('opens the detail panel via the title', () => {
    it('renders the title inside a dedicated data-testid="board-card-title" element', () => {
      render(<BoardCard object={makeObject({ title: 'Design the board view' })} />);

      const title = screen.getByTestId('board-card-title');
      expect(title).toHaveTextContent('Design the board view');
    });

    it('calls openObject(object.id) when the title is clicked', async () => {
      const openObject = mockOpenObject();
      const user = userEvent.setup();
      const object = makeObject({ id: 'obj-42' });

      render(<BoardCard object={object} />);

      await user.click(screen.getByTestId('board-card-title'));

      expect(openObject).toHaveBeenCalledWith('obj-42');
    });

    it('calls openObject(object.id) when Enter is pressed on the focused title', async () => {
      const openObject = mockOpenObject();
      const user = userEvent.setup();
      const object = makeObject({ id: 'obj-42' });

      render(<BoardCard object={object} />);

      screen.getByTestId('board-card-title').focus();
      await user.keyboard('{Enter}');

      expect(openObject).toHaveBeenCalledWith('obj-42');
    });

    it('still spreads useDraggable listeners/attributes on the root board-card element (drag-and-drop unaffected)', () => {
      const object = makeObject({ id: 'obj-42' });

      render(<BoardCard object={object} />);

      // The mocked useDraggable above returns {} for both attributes and
      // listeners, so this only proves the root element still exists and
      // useDraggable is still wired — the real spread-props behavior is
      // exercised by dnd-kit itself, out of scope here (see header comment).
      expect(mockedUseDraggable).toHaveBeenCalledWith(expect.objectContaining({ id: 'obj-42' }));
      expect(screen.getByTestId('board-card')).toBeInTheDocument();
    });
  });
});
