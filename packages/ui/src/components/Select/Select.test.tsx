import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from './Select.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Select/Select.tsx + Select.module.css to satisfy
 * these tests, and add `@radix-ui/react-select` as a dependency):
 *
 *   export const SelectRoot = Select.Root;    // no DOM output of its own — re-exported as-is
 *   export const SelectTrigger = forwardRef<HTMLButtonElement, ...>(...);  // wraps Select.Trigger
 *   export const SelectValue = forwardRef<HTMLSpanElement, ...>(...);      // wraps Select.Value
 *   export const SelectContent = forwardRef<HTMLDivElement, ...>(...);
 *       // Internally composes Select.Portal > Select.Content (ref, styles.content) >
 *       // Select.Viewport — callers use <SelectContent> directly with <SelectItem>
 *       // children, they do NOT separately import/compose Portal or Viewport.
 *   export const SelectItem = forwardRef<HTMLDivElement, ...>(...);
 *       // wraps Select.Item (styles.item), internally rendering Select.ItemText
 *       // around `children` and a Select.ItemIndicator checkmark.
 *
 * Props extend `Omit<ComponentPropsWithoutRef<typeof Select.X>,
 * 'dangerouslySetInnerHTML'>` on every part that forwards `...rest` onto a
 * rendered DOM element (security-reviewer requirement from PR-A).
 *
 * Behavior under test (Radix-owned):
 * - `Enter` or `Space` on a focused trigger (`role="combobox"`) opens the
 *   listbox (`role="listbox"` containing `role="option"` children).
 * - The option matching the current value is focused when the listbox opens;
 *   `ArrowDown` moves focus to the next option.
 * - `Enter` on a focused option commits it (fires `onValueChange`), closes the
 *   listbox, and updates the trigger's displayed value.
 * - `Escape` closes the listbox WITHOUT firing `onValueChange` and without
 *   changing the previously committed/displayed value.
 */

function TestSelect({ onValueChange }: { onValueChange?: (value: string) => void }) {
  return (
    <SelectRoot defaultValue="apple" onValueChange={onValueChange}>
      <SelectTrigger aria-label="Fruit">
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">Apple</SelectItem>
        <SelectItem value="banana">Banana</SelectItem>
        <SelectItem value="cherry">Cherry</SelectItem>
      </SelectContent>
    </SelectRoot>
  );
}

describe('Select', () => {
  it('opens the listbox when the trigger receives Enter', async () => {
    const user = userEvent.setup();
    render(<TestSelect />);

    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('opens the listbox when the trigger receives Space', async () => {
    const user = userEvent.setup();
    render(<TestSelect />);

    await user.tab();
    await user.keyboard(' ');

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('ArrowDown navigates focus between options', async () => {
    const user = userEvent.setup();
    render(<TestSelect />);

    await user.tab();
    await user.keyboard('{Enter}');
    const options = await screen.findAllByRole('option');
    // The already-selected value (apple) starts focused when the listbox opens.
    expect(options[0]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveFocus();
  });

  it('Enter commits the focused option, closes the listbox, and fires onValueChange', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<TestSelect onValueChange={onValueChange} />);

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('option');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('banana');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Banana');
  });

  it('Escape closes the listbox without changing the previously committed value', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<TestSelect onValueChange={onValueChange} />);

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('option');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');

    expect(onValueChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Apple');
  });
});
