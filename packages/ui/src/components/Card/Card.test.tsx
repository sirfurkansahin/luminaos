import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { Card } from './Card.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Card/Card.tsx to satisfy these tests):
 *
 * `Card` is a thin `forwardRef<HTMLDivElement, CardProps>` wrapper around a native
 * `<div>` — just a styled container + children, per the plan (no variant prop).
 *
 *   type CardProps = React.HTMLAttributes<HTMLDivElement>;
 *
 * - All native div attributes (data-*, aria-*, etc.) must be forwarded/spread onto
 *   the rendered `<div>`.
 * - The ref must resolve to the underlying `HTMLDivElement`.
 * - A plain `<div>` has no strong implicit ARIA role, so these tests assert on
 *   rendered children content rather than `getByRole`.
 */

describe('Card', () => {
  it('renders its children content', () => {
    render(
      <Card>
        <p>Card body text</p>
      </Card>,
    );
    expect(screen.getByText('Card body text')).toBeInTheDocument();
  });

  it('forwards the ref to the underlying <div> element', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref}>content</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('passes through arbitrary native HTML attributes', () => {
    render(
      <Card data-testid="my-card" aria-label="summary card">
        content
      </Card>,
    );
    const card = screen.getByTestId('my-card');
    expect(card).toHaveAttribute('aria-label', 'summary card');
  });
});
