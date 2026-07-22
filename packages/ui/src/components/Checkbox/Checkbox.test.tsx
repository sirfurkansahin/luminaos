import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Checkbox/Checkbox.tsx + Checkbox.module.css to
 * satisfy these tests, and add `@radix-ui/react-checkbox` as a dependency):
 *
 * Unlike Dialog/DropdownMenu/Select/Tabs, Radix's Checkbox has only two
 * compound parts (`Root` + `Indicator`, the latter only rendering when
 * checked) that are always used together — so, matching the Button/Input/
 * Textarea singular-wrapper pattern rather than exposing separate named
 * parts, `Checkbox` is ONE `forwardRef<HTMLButtonElement, CheckboxProps>`
 * component that internally renders `Checkbox.Root` (ref, styles.root,
 * `...rest`) containing `Checkbox.Indicator` (styles.indicator) with a
 * checkmark glyph — the indicator's presence/visibility is entirely
 * Radix-driven via its internal `data-state`.
 *
 *   interface CheckboxProps extends Omit<
 *     ComponentPropsWithoutRef<typeof RadixCheckbox.Root>,
 *     'dangerouslySetInnerHTML'
 *   > {}
 *
 * v0 scope is deliberately limited to the boolean checked/unchecked state
 * (no `indeterminate` support yet — out of scope per the task brief).
 *
 * Behavior under test (Radix-owned):
 * - Renders with `role="checkbox"` and `aria-checked="false"` by default
 *   (uncontrolled, no `defaultChecked`).
 * - `Space` on a focused checkbox toggles `aria-checked` between `"true"`/`"false"`.
 * - `onCheckedChange` fires with the new boolean value on each toggle.
 */

function TestCheckbox({
  onCheckedChange,
}: {
  onCheckedChange?: (checked: boolean | 'indeterminate') => void;
}) {
  return <Checkbox aria-label="Accept terms" onCheckedChange={onCheckedChange} />;
}

describe('Checkbox', () => {
  it('renders unchecked by default with aria-checked="false"', () => {
    render(<TestCheckbox />);

    expect(screen.getByRole('checkbox', { name: 'Accept terms' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('Space toggles aria-checked from false to true', async () => {
    const user = userEvent.setup();
    render(<TestCheckbox />);

    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    checkbox.focus();
    await user.keyboard(' ');

    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });

  it('Space toggles aria-checked back from true to false', async () => {
    const user = userEvent.setup();
    render(<TestCheckbox />);

    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    checkbox.focus();
    await user.keyboard(' ');
    await user.keyboard(' ');

    expect(checkbox).toHaveAttribute('aria-checked', 'false');
  });

  it('fires onCheckedChange with the new boolean value on each toggle', async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(<TestCheckbox onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    checkbox.focus();
    await user.keyboard(' ');

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    await user.keyboard(' ');

    expect(onCheckedChange).toHaveBeenCalledTimes(2);
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });
});
