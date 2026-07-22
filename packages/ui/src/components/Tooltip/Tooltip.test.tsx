import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent } from './Tooltip.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Tooltip/Tooltip.tsx + Tooltip.module.css to
 * satisfy these tests, and add `@radix-ui/react-tooltip` as a dependency):
 *
 *   export const TooltipProvider = Tooltip.Provider;  // no DOM output — re-exported as-is,
 *                                                      // required ancestor (per-app, mount once)
 *   export const TooltipRoot = Tooltip.Root;           // no DOM output — re-exported as-is
 *   export const TooltipTrigger = forwardRef<HTMLButtonElement, ...>(...); // wraps Tooltip.Trigger
 *   export const TooltipContent = forwardRef<HTMLDivElement, ...>(...);
 *       // Internally composes Tooltip.Portal > Tooltip.Content (ref, styles.content) —
 *       // callers use <TooltipContent> directly.
 *
 * Props extend `Omit<ComponentPropsWithoutRef<typeof Tooltip.X>,
 * 'dangerouslySetInnerHTML'>` on every part that forwards `...rest` onto a
 * rendered DOM element (security-reviewer requirement from PR-A).
 *
 * Behavior under test — specifically the thing Radix gets right that a
 * hand-rolled tooltip usually gets wrong: the content must become visible on
 * KEYBOARD FOCUS of the trigger, not only on mouse hover. `TooltipProvider`
 * is given `delayDuration={0}` in the test fixture for fast, deterministic
 * assertions (Radix's hover-intent delay does not gate focus-triggered opens,
 * but a zero delay keeps this test robust regardless).
 */

function TestTooltip() {
  return (
    <TooltipProvider delayDuration={0}>
      <TooltipRoot>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful hint</TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
}

describe('Tooltip', () => {
  it('is not visible before the trigger is focused', () => {
    render(<TestTooltip />);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('becomes visible when the trigger receives keyboard focus', async () => {
    const user = userEvent.setup();
    render(<TestTooltip />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Hover me' })).toHaveFocus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Helpful hint');
  });

  it('hides again when focus leaves the trigger', async () => {
    const user = userEvent.setup();
    render(
      <>
        <TestTooltip />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.tab();
    await screen.findByRole('tooltip');

    await user.tab();

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });
});
