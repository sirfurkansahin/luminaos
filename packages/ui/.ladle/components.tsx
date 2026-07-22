import { Button } from '../src/components/Button/Button.js';
import { ToastProvider } from '../src/components/Toast/ToastProvider.js';
import { TooltipProvider } from '../src/components/Tooltip/Tooltip.js';
import { ThemeProvider } from '../src/theme/ThemeProvider.js';
import { useTheme } from '../src/theme/useTheme.js';

import '../src/tokens.css';

import type { GlobalProvider } from '@ladle/react';

/**
 * Ladle ships its own light/dark control-panel toggle (`globalState.theme`),
 * but that only switches Ladle's own chrome — it has no wiring into our
 * `ThemeProvider`'s `data-theme` attribute, so it would not actually re-theme
 * any story. Rather than adding a controlled-theme prop to the already
 * committed/tested `ThemeProvider` just for this, render our own toggle here
 * so the gallery has a genuinely working light/dark switch for components
 * (F0-T7 AC: "light/dark geçişi çalışır").
 */
function GalleryThemeToggle(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme();
  return (
    <div style={{ padding: '0.5rem' }}>
      <Button variant="ghost" size="sm" onClick={toggleTheme}>
        Toggle theme ({theme})
      </Button>
    </div>
  );
}

// Ladle's documented global-decorator convention: a named `Provider` export
// from `.ladle/components.tsx` wraps every story. Radix's Tooltip/Toast both
// require their provider ancestors to be mounted, and every component needs
// `tokens.css` (imported once, above) for themed CSS custom properties to
// resolve. `ThemeProvider` also needs to be present so any story exercising
// `useTheme()` renders without throwing.
export const Provider: GlobalProvider = ({ children }) => (
  <ThemeProvider>
    <TooltipProvider>
      <ToastProvider>
        <GalleryThemeToggle />
        {children}
      </ToastProvider>
    </TooltipProvider>
  </ThemeProvider>
);
