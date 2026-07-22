import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { Badge } from './Badge.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Badge/Badge.tsx to satisfy these tests):
 *
 * `Badge` is a thin `forwardRef<HTMLSpanElement, BadgeProps>` wrapper around a
 * native `<span>` element.
 *
 *   type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger';
 *
 *   interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
 *     variant?: BadgeVariant; // default 'neutral'
 *   }
 *
 * - All native span attributes (data-*, aria-*, etc.) must be forwarded/spread onto
 *   the rendered `<span>`.
 * - The ref must resolve to the underlying `HTMLSpanElement`.
 * - `variant` is mapped internally to a CSS Module class name — not asserted here by
 *   exact string (CSS Modules hash class names unpredictably); we only assert the
 *   className is non-empty and differs between variants.
 * - A plain `<span>` has no strong implicit ARIA role, so these tests assert on
 *   rendered children content rather than `getByRole`.
 */

describe('Badge', () => {
  it('renders its children content', () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('forwards the ref to the underlying <span> element', () => {
    const ref = createRef<HTMLSpanElement>();
    render(<Badge ref={ref}>New</Badge>);
    expect(ref.current).toBeInstanceOf(HTMLSpanElement);
  });

  it('passes through arbitrary native HTML attributes', () => {
    render(
      <Badge data-testid="my-badge" aria-label="status: new">
        New
      </Badge>,
    );
    const badge = screen.getByTestId('my-badge');
    expect(badge).toHaveAttribute('aria-label', 'status: new');
  });

  it('maps distinct variants to distinct (non-empty) class names', () => {
    const { rerender } = render(<Badge variant="neutral">Status</Badge>);
    const neutralClassName = screen.getByText('Status').className;
    expect(neutralClassName).not.toBe('');

    rerender(<Badge variant="danger">Status</Badge>);
    const dangerClassName = screen.getByText('Status').className;

    expect(dangerClassName).not.toBe('');
    expect(dangerClassName).not.toBe(neutralClassName);
  });
});
