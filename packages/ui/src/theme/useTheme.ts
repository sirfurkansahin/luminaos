import { useContext } from 'react';

import { ThemeContext, type ThemeContextValue } from './ThemeContext.js';

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    // A bare `throw new Error` is used deliberately here, not a
    // `packages/shared/errors` `AppError` subclass: this is the standard
    // React context-usage-guard pattern (a programmer-error assertion caught
    // at development time, never surfaced as an HTTP response), and
    // `AppError`'s `code`/`statusCode` contract is API-response-oriented —
    // forcing a fake status code onto it would misrepresent what this is.
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
