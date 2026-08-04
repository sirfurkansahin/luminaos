import { fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { DateTimePicker } from './DateTimePicker.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/DateTimePicker/DateTimePicker.tsx to satisfy these
 * tests):
 *
 * `DateTimePicker` is a thin `forwardRef<HTMLInputElement, DateTimePickerProps>`
 * wrapper around a native `<input type="date">` / `<input type="datetime-local">`
 * element — no calendar grid, no new npm dependency (mirrors `Input`'s
 * "thin wrapper around a native element" pattern, see Input.tsx/Input.test.tsx).
 *
 *   export interface DateTimePickerProps
 *     extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'dangerouslySetInnerHTML'> {
 *     mode?: 'date' | 'datetime-local'; // defaults to 'datetime-local'
 *   }
 *
 *   export const DateTimePicker: React.ForwardRefExoticComponent<
 *     DateTimePickerProps & React.RefAttributes<HTMLInputElement>
 *   >;
 *
 * - `mode` controls the rendered native `type` attribute: `'date'` -> `type="date"`,
 *   `'datetime-local'` (or omitted) -> `type="datetime-local"`.
 * - `mode` itself must NEVER be forwarded onto the DOM `<input>` (it is not a valid
 *   HTML attribute).
 * - All other native input attributes (value, onChange, disabled, data-*, aria-*,
 *   etc.) must be forwarded/spread onto the rendered `<input>`, same as `Input`.
 * - The ref must resolve to the underlying `HTMLInputElement`.
 *
 * Note on interaction testing: jsdom's `<input type="date">` / `type="datetime-local">`
 * do not support realistic keystroke-by-keystroke simulation the way
 * `userEvent.type` expects for text inputs (there is no existing `type="date"`
 * test precedent elsewhere in this repo to mirror — searched apps/web's
 * EditableCell.test.tsx and packages/ui's other component tests, neither uses
 * date-shaped inputs). The controlled-input test below instead uses
 * `fireEvent.change` with a direct `.value` assignment, which is the standard
 * RTL-recommended approach for date/datetime-local inputs.
 */

function ControlledDateTimePicker(): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <DateTimePicker
      mode="date"
      aria-label="controlled-date-picker"
      value={value}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        setValue(e.target.value);
      }}
    />
  );
}

describe('DateTimePicker', () => {
  it('renders a native <input type="datetime-local"> when mode is omitted (default)', () => {
    const { container } = render(<DateTimePicker aria-label="my-datetime-picker" />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('type', 'datetime-local');
  });

  it('renders a native <input type="date"> when mode="date" is explicitly passed', () => {
    const { container } = render(<DateTimePicker mode="date" aria-label="my-date-picker" />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('type', 'date');
  });

  it('never forwards the mode prop itself onto the DOM <input> element', () => {
    const { container } = render(<DateTimePicker mode="date" aria-label="my-date-picker" />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('mode')).toBeNull();
  });

  it('forwards the ref to the underlying <input> element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<DateTimePicker ref={ref} aria-label="my-datetime-picker" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('passes through arbitrary native HTML attributes', () => {
    render(
      <DateTimePicker mode="date" data-testid="my-date-picker" aria-label="due date" disabled />,
    );
    const input = screen.getByTestId('my-date-picker');
    expect(input).toHaveAttribute('aria-label', 'due date');
    expect(input).toBeDisabled();
  });

  it('behaves as a controlled input: changing the value fires onChange with the expected value', () => {
    render(<ControlledDateTimePicker />);

    const input = screen.getByLabelText('controlled-date-picker');
    fireEvent.change(input, { target: { value: '2026-08-15' } });

    expect(input).toHaveValue('2026-08-15');
  });
});
