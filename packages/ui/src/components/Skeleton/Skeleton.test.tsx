import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton } from './Skeleton.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Skeleton/Skeleton.tsx + Skeleton.module.css to
 * satisfy these tests):
 *
 * `Skeleton` is a loading-state placeholder element (`forwardRef<HTMLDivElement,
 * SkeletonProps>` following the Badge/Button className-composition pattern):
 *
 *   type SkeletonVariant = 'text' | 'rect' | 'circle';
 *
 *   interface SkeletonProps extends Omit<
 *     HTMLAttributes<HTMLDivElement>,
 *     'dangerouslySetInnerHTML'
 *   > {
 *     variant?: SkeletonVariant; // default 'text'
 *     width?: number | string;
 *     height?: number | string;
 *   }
 *
 * - It renders a single element carrying `role="status"` and `aria-busy="true"`
 *   (WCAG loading-indicator convention, same a11y-attribute-assertion style as
 *   Dialog.test.tsx's `getByRole('dialog')` checks) so assistive tech announces
 *   the loading region without spamming screen readers on every re-render.
 * - `className` composes with the internal base/variant class names, same
 *   `[styles.base, styles[variant], className].filter(Boolean).join(' ')`
 *   pattern as Badge/Button — caller-supplied classes must never be dropped.
 * - `width`/`height`, when provided, are reflected onto the rendered element's
 *   inline `style` (not baked into a CSS Module class, since they are
 *   per-instance values).
 */

describe('Skeleton', () => {
  it('renders with role="status" and aria-busy="true" to signal a loading region', () => {
    render(<Skeleton data-testid="skeleton" />);
    const skeleton = screen.getByRole('status');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('composes a caller-supplied className with its internal base class', () => {
    render(<Skeleton data-testid="skeleton" className="custom-class" />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.className).toContain('custom-class');
    expect(skeleton.className.trim()).not.toBe('custom-class');
  });

  it('reflects the width prop onto inline style', () => {
    render(<Skeleton data-testid="skeleton" width={120} />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.style.width).toBe('120px');
  });

  it('reflects the height prop onto inline style', () => {
    render(<Skeleton data-testid="skeleton" height="2rem" />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.style.height).toBe('2rem');
  });

  it('accepts a variant prop without throwing (text | rect | circle)', () => {
    const { rerender } = render(<Skeleton data-testid="skeleton" variant="text" />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();

    rerender(<Skeleton data-testid="skeleton" variant="rect" />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();

    rerender(<Skeleton data-testid="skeleton" variant="circle" />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });
});
