import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Input } from './Input.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Input/Input.tsx to satisfy these tests):
 *
 * `Input` is a thin `forwardRef<HTMLInputElement, InputProps>` wrapper around a
 * native `<input>` element.
 *
 *   type InputProps = React.InputHTMLAttributes<HTMLInputElement>;
 *
 * - It is a plain controlled-component passthrough: no extra variant/size props for
 *   PR-A (kept minimal per the plan). All native input attributes (value, onChange,
 *   type, disabled, data-*, aria-*, etc.) must be forwarded/spread onto the
 *   rendered `<input>`.
 * - The ref must resolve to the underlying `HTMLInputElement`.
 */

function ControlledInput() {
  const [value, setValue] = useState('');
  return (
    <Input
      aria-label="controlled-input"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
      }}
    />
  );
}

describe('Input', () => {
  it('renders with the implicit textbox role', () => {
    render(<Input aria-label="my-input" />);
    expect(screen.getByRole('textbox', { name: 'my-input' })).toBeInTheDocument();
  });

  it('forwards the ref to the underlying <input> element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="my-input" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('passes through arbitrary native HTML attributes', () => {
    render(<Input data-testid="my-input" aria-label="email address" />);
    const input = screen.getByTestId('my-input');
    expect(input).toHaveAttribute('aria-label', 'email address');
  });

  it('behaves as a controlled input: typing fires onChange with the expected value', async () => {
    const user = userEvent.setup();
    render(<ControlledInput />);

    const input = screen.getByRole('textbox', { name: 'controlled-input' });
    await user.type(input, 'hello');

    expect(input).toHaveValue('hello');
  });
});
