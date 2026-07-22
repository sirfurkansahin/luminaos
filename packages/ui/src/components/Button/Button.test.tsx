import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Button/Button.tsx to satisfy these tests):
 *
 * `Button` is a thin `forwardRef<HTMLButtonElement, ButtonProps>` wrapper around a
 * native `<button>` element.
 *
 *   type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
 *   type ButtonSize = 'sm' | 'md' | 'lg';
 *
 *   interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
 *     variant?: ButtonVariant; // default 'primary'
 *     size?: ButtonSize;       // default 'md'
 *   }
 *
 * - All native button attributes (disabled, onClick, data-*, aria-*, type, etc.)
 *   must be forwarded/spread onto the rendered `<button>`.
 * - The ref must resolve to the underlying `HTMLButtonElement`.
 * - `variant`/`size` are mapped internally to CSS Module class names — not asserted
 *   here by exact string (CSS Modules hash class names unpredictably).
 */

describe('Button', () => {
  it('renders with the implicit button role', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('forwards the ref to the underlying <button> element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Click me</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('passes through arbitrary native HTML attributes', () => {
    render(
      <Button data-testid="my-button" aria-label="save document">
        Save
      </Button>,
    );
    const button = screen.getByTestId('my-button');
    expect(button).toHaveAttribute('aria-label', 'save document');
  });

  it('does not fire onClick when disabled', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={handleClick}>
        Click me
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: 'Click me' }));

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('fires onClick when enabled', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={handleClick}>Click me</Button>);

    await user.click(screen.getByRole('button', { name: 'Click me' }));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('maps distinct variants to distinct (non-empty) class names', () => {
    const { rerender } = render(<Button variant="primary">Click me</Button>);
    const primaryClassName = screen.getByRole('button').className;
    expect(primaryClassName).not.toBe('');

    rerender(<Button variant="destructive">Click me</Button>);
    const destructiveClassName = screen.getByRole('button').className;

    expect(destructiveClassName).not.toBe('');
    expect(destructiveClassName).not.toBe(primaryClassName);
  });
});
