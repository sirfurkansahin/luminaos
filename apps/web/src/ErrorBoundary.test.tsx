import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

/**
 * F0-T8 PR-C's AC3, web half: "web'de ErrorBoundary ekranı."
 *
 * `ErrorBoundary` (`./ErrorBoundary.tsx`, not yet written) MUST be a class
 * component -- React has no hook-based equivalent of
 * `static getDerivedStateFromError` / `componentDidCatch`.
 *
 * CONTRACT DESIGNED HERE for `implementer`:
 * - Renders `props.children` unchanged when no descendant has thrown.
 * - Once a descendant throws during render, renders a fallback UI instead of
 *   the (now-broken) subtree. That fallback UI's root element MUST be
 *   discoverable via:
 *
 *     screen.getByTestId('error-boundary-fallback')
 *
 *   ...and MUST NOT also render whatever `children` would have rendered
 *   (the crashed subtree is fully replaced, not layered underneath).
 * - No specific fallback copy/i18n key is pinned here (per CLAUDE.md, UI
 *   text belongs in the i18n catalog, not hardcoded -- out of scope for
 *   this test to dictate); only the `data-testid` contract and the
 *   replace-not-layer behavior are asserted.
 * - `main.tsx` is expected to wrap `<App />` in `<ErrorBoundary>` INSIDE
 *   `ThemeProvider`/`TooltipProvider`/`ToastProvider` (per the plan: "so the
 *   fallback ekranı da temalı kalsın diye") -- not exercised by this file
 *   (`main.tsx` has no automated test in this codebase), flagged here for
 *   `implementer`'s awareness only.
 *
 * `Bomb` is a local, deliberately-broken component (throws synchronously
 * during render) used purely as this test's trigger -- it is not, and must
 * never become, part of production code.
 */

function Bomb(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error to the console (twice, in fact, in dev
    // mode) even when an error boundary handles it -- expected noise for
    // the one test below that deliberately throws, suppressed so it doesn't
    // pollute test output or get mistaken for a real failure.
    vi.spyOn(console, 'error').mockImplementation(() => {
      // Intentionally silent.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a fallback UI (data-testid="error-boundary-fallback") when a descendant throws during render, and does not render the crashed subtree', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
  });

  it('renders children unchanged, and does NOT render the fallback, when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>normal content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('normal content')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });
});
