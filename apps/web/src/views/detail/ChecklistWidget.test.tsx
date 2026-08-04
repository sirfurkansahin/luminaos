import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChecklistItem } from '@luminaos/core-objects';

import { ChecklistWidget } from './ChecklistWidget.js';
import { useChecklistMutations } from '../../hooks/useChecklistMutations.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/detail/ChecklistWidget.tsx to satisfy these tests. That's
 * the expected TDD red state — this file fails to even resolve its own
 * `./ChecklistWidget.js` import (nor `../../hooks/useChecklistMutations.js`,
 * pinned separately by useChecklistMutations.test.ts) until both exist.
 *
 *   export interface ChecklistWidgetProps {
 *     workspaceId: string;
 *     objectId: string;
 *     items: ChecklistItem[];   // already-fetched by the parent panel
 *                               // (data.object.checklist) and passed down —
 *                               // mirrors StatusPrioritySelect's "parent
 *                               // passes down already-fetched data"
 *                               // convention. This widget never fetches its
 *                               // own data.
 *   }
 *   export function ChecklistWidget(props: ChecklistWidgetProps): React.JSX.Element;
 *
 * Internally calls `useChecklistMutations(workspaceId, objectId)`
 * (../../hooks/useChecklistMutations.js, mocked wholesale below — this file
 * only proves ChecklistWidget wires the four mutate functions correctly, not
 * their real optimistic/rollback internals, which are separately pinned by
 * useChecklistMutations.test.ts. Mirrors StatusPrioritySelect.test.tsx's
 * "mock the mutation hook wholesale" style).
 *
 * REORDER-UI DESIGN DECISION (documented per task brief, final call made by
 * test-writer after reading existing repo patterns): simple per-item
 * up/down buttons, NOT `@dnd-kit/core` drag-and-drop. Reasoning:
 *   - `@dnd-kit/core` in this repo (BoardCard.tsx/BoardView.tsx) operates
 *     over a much larger surface — whole-page column drop targets, a
 *     `DndContext` mounted at the board-view level, `useDraggable`/
 *     `useDroppable` pairs, collision detection tuned for that layout. None
 *     of that machinery is a natural fit for a handful of short text rows
 *     inside a modal `DialogContent`.
 *   - Pulling `@dnd-kit/core` into a *second*, structurally unrelated
 *     drag surface (a small embedded list, not a page-level board) inside
 *     this same PR would meaningfully grow scope for a widget whose PR is
 *     explicitly budgeted small ("mekanik" tier, not "mimari-kritik") in the
 *     plan.
 *   - Up/down buttons are fully keyboard-accessible out of the box (no
 *     dnd-kit keyboard sensor wiring needed), which a checklist embedded in
 *     a dialog benefits from more than drag affordance does.
 *   - Testids: `data-testid="checklist-item-move-up-<itemId>"` /
 *     `"checklist-item-move-down-<itemId>"`, one pair per row, DISABLED
 *     (native `disabled` attribute) at the first/last position respectively
 *     (first item's move-up disabled, last item's move-down disabled).
 *     Clicking either calls `reorderItems.mutate({ orderedItemIds })` with
 *     the FULL id list (in `items` order, sorted by `order`) with the
 *     clicked item's id swapped with its neighbor's.
 *
 * Rows are sorted by `item.order` (ascending) regardless of the order
 * `items` is passed in, mirroring `checklist-commands.ts`'s own
 * `order`-is-authoritative semantics. Each row (data-testid=
 * `checklist-item-<itemId>`) contains:
 *   - a `@luminaos/ui` `Checkbox` (data-testid=`checklist-item-checkbox-
 *     <itemId>`, `aria-label` = the item's text, `checked`/`aria-checked`
 *     reflecting `item.done`) — toggling it calls
 *     `toggleItem.mutate({ itemId })`.
 *   - the item's text, discoverable via `screen.getByText(item.text)`
 *     inside that row.
 *   - a remove `@luminaos/ui` `Button` (data-testid=`checklist-item-remove-
 *     <itemId>`, accessible name "Kaldır") — clicking calls
 *     `removeItem.mutate({ itemId })`.
 *   - the move-up/move-down buttons described above.
 *
 * Below the rows, an "add item" affordance: a `@luminaos/ui` `Input`
 * (data-testid="checklist-add-input") plus a submit `@luminaos/ui` `Button`
 * (data-testid="checklist-add-button", accessible name "Ekle") — mirrors
 * EditableCell.tsx's Enter-to-commit convention: typing text and either
 * pressing Enter inside the input OR clicking the add button calls
 * `addItem.mutate({ text: <typed text> })` and clears the input afterward.
 * Submitting with an empty/whitespace-only draft is a no-op (no mutate
 * call, input stays as-is) — mirrors the domain layer's own non-empty-text
 * guard in checklist-commands.ts's `addChecklistItem`.
 */

interface MutateCall {
  mutate: ReturnType<typeof vi.fn>;
}

function makeMutation(): MutateCall & { mutate: ReturnType<typeof vi.fn> } {
  return {
    mutate: vi.fn(),
  };
}

vi.mock('../../hooks/useChecklistMutations.js', () => ({
  useChecklistMutations: vi.fn(),
}));

const mockedUseChecklistMutations = vi.mocked(useChecklistMutations);

function mockMutations(): {
  addItem: ReturnType<typeof vi.fn>;
  toggleItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  reorderItems: ReturnType<typeof vi.fn>;
} {
  const addItem = makeMutation();
  const toggleItem = makeMutation();
  const removeItem = makeMutation();
  const reorderItems = makeMutation();

  // Cast through `unknown` — the real hook's return type is a full
  // `UseMutationResult` per mutation (per useChecklistMutations.test.ts's
  // own contract comment); this test only needs the `mutate` function each
  // exposes, mirroring StatusPrioritySelect.test.tsx's `mockMutation()`
  // helper's own `as unknown as UseMutationResult<...>` cast style.
  mockedUseChecklistMutations.mockReturnValue({
    addItem,
    toggleItem,
    removeItem,
    reorderItems,
  });

  return {
    addItem: addItem.mutate,
    toggleItem: toggleItem.mutate,
    removeItem: removeItem.mutate,
    reorderItems: reorderItems.mutate,
  };
}

function makeItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id: 'item-1', text: 'Write tests', done: false, order: 0, ...overrides };
}

const workspaceId = 'ws-1';
const objectId = 'obj-1';

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChecklistWidget', () => {
  it('renders one row per item, sorted by order (regardless of array order passed in)', () => {
    mockMutations();
    const items: ChecklistItem[] = [
      makeItem({ id: 'item-2', text: 'Second', order: 1 }),
      makeItem({ id: 'item-1', text: 'First', order: 0 }),
      makeItem({ id: 'item-3', text: 'Third', order: 2 }),
    ];

    render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

    const rows = [
      screen.getByTestId('checklist-item-item-1'),
      screen.getByTestId('checklist-item-item-2'),
      screen.getByTestId('checklist-item-item-3'),
    ];
    expect(within(rows[0] as HTMLElement).getByText('First')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Second')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Third')).toBeInTheDocument();

    // DOM order itself follows `order`, not array-passed order.
    const allRows = screen.getAllByTestId(/^checklist-item-item-\d$/);
    expect(allRows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'checklist-item-item-1',
      'checklist-item-item-2',
      'checklist-item-item-3',
    ]);
  });

  it('renders each row with a checkbox reflecting item.done and the item text', () => {
    mockMutations();
    const items: ChecklistItem[] = [
      makeItem({ id: 'item-1', text: 'Write tests', done: false, order: 0 }),
      makeItem({ id: 'item-2', text: 'Ship it', done: true, order: 1 }),
    ];

    render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

    expect(screen.getByTestId('checklist-item-checkbox-item-1')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByTestId('checklist-item-checkbox-item-2')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it("calls toggleItem.mutate({ itemId }) when a row's checkbox is clicked", async () => {
    const { toggleItem } = mockMutations();
    const user = userEvent.setup();
    const items: ChecklistItem[] = [makeItem({ id: 'item-1', text: 'Write tests' })];

    render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

    await user.click(screen.getByTestId('checklist-item-checkbox-item-1'));

    expect(toggleItem).toHaveBeenCalledWith({ itemId: 'item-1' });
  });

  it("calls removeItem.mutate({ itemId }) when a row's remove button is clicked", async () => {
    const { removeItem } = mockMutations();
    const user = userEvent.setup();
    const items: ChecklistItem[] = [makeItem({ id: 'item-1', text: 'Write tests' })];

    render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

    await user.click(screen.getByTestId('checklist-item-remove-item-1'));

    expect(removeItem).toHaveBeenCalledWith({ itemId: 'item-1' });
  });

  describe('add item', () => {
    it('calls addItem.mutate({ text }) with the typed text when the add button is clicked', async () => {
      const { addItem } = mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={[]} />);

      await user.type(screen.getByTestId('checklist-add-input'), 'Buy milk');
      await user.click(screen.getByTestId('checklist-add-button'));

      expect(addItem).toHaveBeenCalledWith({ text: 'Buy milk' });
    });

    it('calls addItem.mutate({ text }) with the typed text when Enter is pressed inside the input', async () => {
      const { addItem } = mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={[]} />);

      await user.type(screen.getByTestId('checklist-add-input'), 'Buy milk{Enter}');

      expect(addItem).toHaveBeenCalledWith({ text: 'Buy milk' });
    });

    it('clears the input after a successful submit', async () => {
      mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={[]} />);

      const input = screen.getByTestId('checklist-add-input');
      await user.type(input, 'Buy milk{Enter}');

      expect(input).toHaveValue('');
    });

    it('does not call addItem.mutate when submitting an empty/whitespace-only draft', async () => {
      const { addItem } = mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={[]} />);

      await user.type(screen.getByTestId('checklist-add-input'), '   {Enter}');

      expect(addItem).not.toHaveBeenCalled();
    });
  });

  describe('reorder (up/down buttons)', () => {
    const items: ChecklistItem[] = [
      makeItem({ id: 'item-1', text: 'First', order: 0 }),
      makeItem({ id: 'item-2', text: 'Second', order: 1 }),
      makeItem({ id: 'item-3', text: 'Third', order: 2 }),
    ];

    it("disables the first item's move-up button and the last item's move-down button", () => {
      mockMutations();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

      expect(screen.getByTestId('checklist-item-move-up-item-1')).toBeDisabled();
      expect(screen.getByTestId('checklist-item-move-down-item-3')).toBeDisabled();
      expect(screen.getByTestId('checklist-item-move-down-item-1')).toBeEnabled();
      expect(screen.getByTestId('checklist-item-move-up-item-3')).toBeEnabled();
    });

    it('calls reorderItems.mutate with the ids swapped when a middle item is moved up', async () => {
      const { reorderItems } = mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

      await user.click(screen.getByTestId('checklist-item-move-up-item-2'));

      expect(reorderItems).toHaveBeenCalledWith({
        orderedItemIds: ['item-2', 'item-1', 'item-3'],
      });
    });

    it('calls reorderItems.mutate with the ids swapped when a middle item is moved down', async () => {
      const { reorderItems } = mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

      await user.click(screen.getByTestId('checklist-item-move-down-item-2'));

      expect(reorderItems).toHaveBeenCalledWith({
        orderedItemIds: ['item-1', 'item-3', 'item-2'],
      });
    });

    it('does not call reorderItems.mutate when the disabled first move-up button is clicked', async () => {
      const { reorderItems } = mockMutations();
      const user = userEvent.setup();

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

      await user.click(screen.getByTestId('checklist-item-move-up-item-1'));

      expect(reorderItems).not.toHaveBeenCalled();
    });
  });

  describe('optimistic (temp-id) rows', () => {
    it('disables the checkbox, remove and move buttons for a row whose id is still a client-generated temp id, while a normal-id row stays enabled', () => {
      mockMutations();
      const items: ChecklistItem[] = [
        makeItem({ id: 'item-1', text: 'First', order: 0 }),
        makeItem({ id: 'temp-abc123', text: 'Second (optimistic)', order: 1 }),
      ];

      render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={items} />);

      expect(screen.getByTestId('checklist-item-checkbox-temp-abc123')).toBeDisabled();
      expect(screen.getByTestId('checklist-item-remove-temp-abc123')).toBeDisabled();
      expect(screen.getByTestId('checklist-item-move-up-temp-abc123')).toBeDisabled();
      expect(screen.getByTestId('checklist-item-move-down-temp-abc123')).toBeDisabled();

      expect(screen.getByTestId('checklist-item-checkbox-item-1')).toBeEnabled();
      expect(screen.getByTestId('checklist-item-remove-item-1')).toBeEnabled();
      expect(screen.getByTestId('checklist-item-move-down-item-1')).toBeEnabled();
    });
  });

  it('renders no rows and no crash when items is an empty array', () => {
    mockMutations();

    render(<ChecklistWidget workspaceId={workspaceId} objectId={objectId} items={[]} />);

    expect(screen.queryAllByTestId(/^checklist-item-item-/)).toHaveLength(0);
    expect(screen.getByTestId('checklist-add-input')).toBeInTheDocument();
  });
});
