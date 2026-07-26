import '@luminaos/ui/tokens.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider, ToastProvider, TooltipProvider } from '@luminaos/ui';

import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { queryClient } from './lib/queryClient';

const container = document.getElementById('root');
if (!container) {
  // A bare `throw new Error` is deliberate here, not a `packages/shared/errors`
  // `AppError` subclass: this is a client-side bootstrap invariant (the mount
  // point missing from `index.html` is a build/deploy-config bug, never
  // user-triggered), and `AppError`'s `code`/`statusCode` contract is
  // API-response-oriented — it doesn't map onto a pre-render failure with no
  // HTTP request involved. Mirrors the same reasoning documented in
  // `packages/ui/src/theme/useTheme.ts`.
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
