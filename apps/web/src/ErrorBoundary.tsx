import { Component } from 'react';

import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * F0-T8 PR-C's AC3, web half: a top-level render-error boundary so a thrown
 * error from anywhere in the React tree renders a fallback screen instead of
 * an unmounted blank page. React has no hook-based equivalent of
 * `static getDerivedStateFromError`/`componentDidCatch`, so this must be a
 * class component.
 *
 * `componentDidCatch` logs the caught error via `console.error` for local
 * dev visibility only — no external error-reporting service (Sentry-style)
 * is wired here, per the spec's explicit scope exclusion.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Local dev visibility only — never shipped to an external service (no
    // Sentry-style integration exists in this codebase).
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div data-testid="error-boundary-fallback" role="alert">
          Something went wrong.
        </div>
      );
    }

    return this.props.children;
  }
}
