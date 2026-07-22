import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  DialogRoot,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from './Dialog.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Dialog/Dialog.tsx + Dialog.module.css to satisfy
 * these tests, and add `@radix-ui/react-dialog` as a dependency):
 *
 * Thin CSS-Module-attaching wrappers around `@radix-ui/react-dialog`'s compound
 * parts (`Root/Trigger/Portal/Overlay/Content/Title/Description/Close`) — Radix
 * owns ALL focus-trap/ARIA/Escape/portal behavior, we only attach our own
 * `className`s (composed with any caller-supplied `className` via the same
 * `[styles.x, className].filter(Boolean).join(' ')` pattern as Button/Input).
 *
 *   export const DialogRoot = Dialog.Root;    // no DOM output of its own — re-exported as-is
 *   export const DialogTrigger = forwardRef<HTMLButtonElement, DialogTriggerProps>(...);
 *   export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(...);
 *       // Internally composes Dialog.Portal > Dialog.Overlay (styles.overlay) >
 *       // Dialog.Content (ref, styles.content). Callers use <DialogContent> directly —
 *       // they do NOT separately import/compose Portal or Overlay (shadcn/ui convenience).
 *   export const DialogTitle = forwardRef<HTMLHeadingElement, DialogTitleProps>(...);
 *   export const DialogDescription = forwardRef<HTMLParagraphElement, DialogDescriptionProps>(...);
 *   export const DialogClose = forwardRef<HTMLButtonElement, DialogCloseProps>(...);
 *
 * Every wrapped part's props extend
 * `Omit<ComponentPropsWithoutRef<typeof Dialog.X>, 'dangerouslySetInnerHTML'>`
 * (security-reviewer requirement carried forward from PR-A onto every component
 * that forwards `...rest` onto a rendered DOM element).
 *
 * Behavior under test (all owned by Radix — we only prove it flows through our
 * wrappers unbroken):
 * - Clicking DialogTrigger opens the dialog; DialogContent becomes visible with
 *   `role="dialog"`.
 * - Tab-cycling within an open dialog never moves focus outside DialogContent
 *   (focus trap).
 * - Escape closes the dialog.
 * - After closing (by any means), focus returns to the DialogTrigger element.
 */

function TestDialog() {
  return (
    <DialogRoot>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Dialog title</DialogTitle>
        <DialogDescription>Dialog description</DialogDescription>
        <button type="button">First action</button>
        <button type="button">Second action</button>
        <DialogClose>Close</DialogClose>
      </DialogContent>
    </DialogRoot>
  );
}

describe('Dialog', () => {
  it('opens and shows dialog content when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Dialog title')).toBeInTheDocument();
  });

  it('traps Tab focus within the dialog content, never escaping to elements outside it', async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = await screen.findByRole('dialog');

    // Tab far more times than there are focusable elements inside the dialog —
    // if the trap works, focus must always remain a descendant of `dialog`.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes the dialog on Escape', async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('returns focus to the trigger after the dialog closes', async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
