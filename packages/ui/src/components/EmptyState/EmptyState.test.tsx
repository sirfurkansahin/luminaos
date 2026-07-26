import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/EmptyState/EmptyState.tsx +
 * EmptyState.module.css to satisfy these tests):
 *
 *   interface EmptyStateProps extends Omit<
 *     HTMLAttributes<HTMLDivElement>,
 *     'dangerouslySetInnerHTML' | 'title'
 *   > {
 *     title: string;              // required
 *     description?: string;       // optional
 *     action?: ReactNode;         // optional, e.g. a <Button>
 *   }
 *
 * - `title` is required and rendered as a heading element (assertable via
 *   `getByRole('heading', { name })`), giving the empty region a landmark
 *   accessible name — same a11y-first assertion style as Dialog.test.tsx.
 * - `description`, when provided, renders as visible text; when omitted, no
 *   description text/element is rendered at all (no empty paragraph left
 *   behind).
 * - `action`, when provided (e.g. a `<Button>Retry</Button>`), is rendered
 *   as-is inside the component; when omitted, no action element is rendered.
 * - The outer container carries `role="status"` so assistive tech is informed
 *   this region communicates the current (empty) state of a list/view — same
 *   `role`-based a11y contract style used by Skeleton/Dialog.
 */

describe('EmptyState', () => {
  it('renders the required title as a heading', () => {
    render(<EmptyState title="No tasks yet" />);
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument();
  });

  it('renders the description when provided', () => {
    render(
      <EmptyState title="No tasks yet" description="Create your first task to get started." />,
    );
    expect(screen.getByText('Create your first task to get started.')).toBeInTheDocument();
  });

  it('does not render a description element when none is provided', () => {
    render(<EmptyState title="No tasks yet" />);
    expect(screen.queryByText('Create your first task to get started.')).not.toBeInTheDocument();
  });

  it('renders the action content when provided', () => {
    render(
      <EmptyState
        title="No tasks yet"
        action={
          <button type="button" onClick={() => {}}>
            Create task
          </button>
        }
      />,
    );
    expect(screen.getByRole('button', { name: 'Create task' })).toBeInTheDocument();
  });

  it('does not render an action element when none is provided', () => {
    render(<EmptyState title="No tasks yet" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('exposes the container with role="status" for assistive tech', () => {
    render(<EmptyState title="No tasks yet" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
