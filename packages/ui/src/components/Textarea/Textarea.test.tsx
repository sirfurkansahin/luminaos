import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Textarea } from './Textarea.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Textarea/Textarea.tsx to satisfy these tests):
 *
 * `Textarea` is a thin `forwardRef<HTMLTextAreaElement, TextareaProps>` wrapper
 * around a native `<textarea>` element.
 *
 *   type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;
 *
 * - Plain controlled-component passthrough: no extra variant/size props for PR-A.
 *   All native textarea attributes (value, onChange, disabled, data-*, aria-*, etc.)
 *   must be forwarded/spread onto the rendered `<textarea>`.
 * - The ref must resolve to the underlying `HTMLTextAreaElement`.
 */

function ControlledTextarea() {
  const [value, setValue] = useState('');
  return (
    <Textarea
      aria-label="controlled-textarea"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
      }}
    />
  );
}

describe('Textarea', () => {
  it('renders with the implicit textbox role', () => {
    render(<Textarea aria-label="my-textarea" />);
    expect(screen.getByRole('textbox', { name: 'my-textarea' })).toBeInTheDocument();
  });

  it('forwards the ref to the underlying <textarea> element', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} aria-label="my-textarea" />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('passes through arbitrary native HTML attributes', () => {
    render(<Textarea data-testid="my-textarea" aria-label="notes" />);
    const textarea = screen.getByTestId('my-textarea');
    expect(textarea).toHaveAttribute('aria-label', 'notes');
  });

  it('behaves as a controlled textarea: typing fires onChange with the expected value', async () => {
    const user = userEvent.setup();
    render(<ControlledTextarea />);

    const textarea = screen.getByRole('textbox', { name: 'controlled-textarea' });
    await user.type(textarea, 'hello world');

    expect(textarea).toHaveValue('hello world');
  });
});
