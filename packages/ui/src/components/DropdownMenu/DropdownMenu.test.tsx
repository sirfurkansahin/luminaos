import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './DropdownMenu.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/DropdownMenu/DropdownMenu.tsx +
 * DropdownMenu.module.css to satisfy these tests, and add
 * `@radix-ui/react-dropdown-menu` as a dependency):
 *
 *   export const DropdownMenuRoot = DropdownMenu.Root;   // no DOM output — re-exported as-is
 *   export const DropdownMenuTrigger = forwardRef<HTMLButtonElement, ...>(...);
 *   export const DropdownMenuContent = forwardRef<HTMLDivElement, ...>(...);
 *       // Internally composes DropdownMenu.Portal > DropdownMenu.Content
 *       // (ref, styles.content) — callers use <DropdownMenuContent> directly.
 *   export const DropdownMenuItem = forwardRef<HTMLDivElement, ...>(...);
 *       // wraps DropdownMenu.Item (styles.item); forwards `onSelect` untouched.
 *
 * Props extend `Omit<ComponentPropsWithoutRef<typeof DropdownMenu.X>,
 * 'dangerouslySetInnerHTML'>` on every part that forwards `...rest` onto a
 * rendered DOM element (security-reviewer requirement from PR-A).
 *
 * Behavior under test (Radix-owned, we only prove our wrappers don't break it):
 * - Opening via `Enter` OR `Space` on a focused trigger shows `role="menu"`
 *   content and auto-focuses the first `role="menuitem"`.
 * - `ArrowDown` moves focus between menu items (roving tabindex).
 * - `Enter` on a focused item fires that item's `onSelect` and closes the menu.
 * - `Escape` closes the menu WITHOUT firing `onSelect`, and returns focus to
 *   the trigger.
 */

function TestMenu({ onSelectFirst }: { onSelectFirst?: (event: Event) => void }) {
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelectFirst}>First item</DropdownMenuItem>
        <DropdownMenuItem>Second item</DropdownMenuItem>
        <DropdownMenuItem>Third item</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

describe('DropdownMenu', () => {
  it('opens via Enter on the trigger and focuses the first menu item', async () => {
    const user = userEvent.setup();
    render(<TestMenu />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();

    await user.keyboard('{Enter}');

    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveFocus();
  });

  it('opens via Space on the trigger', async () => {
    const user = userEvent.setup();
    render(<TestMenu />);

    await user.tab();
    await user.keyboard(' ');

    expect(await screen.findAllByRole('menuitem')).toHaveLength(3);
  });

  it('ArrowDown moves focus through items (roving tabindex)', async () => {
    const user = userEvent.setup();
    render(<TestMenu />);

    await user.tab();
    await user.keyboard('{Enter}');
    const items = await screen.findAllByRole('menuitem');
    expect(items[0]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(items[2]).toHaveFocus();
  });

  it('Enter on a focused item fires onSelect and closes the menu', async () => {
    const onSelectFirst = vi.fn();
    const user = userEvent.setup();
    render(<TestMenu onSelectFirst={onSelectFirst} />);

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('menuitem');

    await user.keyboard('{Enter}');

    expect(onSelectFirst).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('Escape closes the menu without selecting and returns focus to the trigger', async () => {
    const onSelectFirst = vi.fn();
    const user = userEvent.setup();
    render(<TestMenu onSelectFirst={onSelectFirst} />);

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('menuitem');

    await user.keyboard('{Escape}');

    expect(onSelectFirst).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
