import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@luminaos/ui';

import { App } from './App';

/**
 * Theme-toggle contract for `implementer` (F0-T7 PR-C, not yet built):
 *
 * `App.tsx` must render a control that lets the user switch between the
 * 'light' and 'dark' themes via `useTheme()` from `@luminaos/ui`. That
 * control MUST be discoverable in tests via:
 *
 *   screen.getByTestId('theme-toggle')
 *
 * ...and MUST be a real `<button>` element (e.g. `@luminaos/ui`'s `Button`,
 * which renders a native `<button>` under the hood) carrying an accessible
 * name (visible text and/or `aria-label` — exact copy/i18n is up to
 * implementer, these tests do not pin the label string).
 *
 * Clicking it must call `toggleTheme()` (or an equivalent `setTheme(...)`
 * call) from `useTheme()`, which updates
 * `document.documentElement.dataset.theme` between 'light' and 'dark'.
 *
 * `ThemeProvider` itself is NOT expected to be rendered inside `App.tsx` —
 * per the F0-T7 plan, `main.tsx` owns that wrapping in production
 * (`ThemeProvider` + `TooltipProvider` + `ToastProvider` around `<App />`).
 * These tests replicate that `ThemeProvider` wrapping locally (mirroring
 * `main.tsx`) so `useTheme()` resolves during render — `App.tsx` itself
 * should NOT import/render `ThemeProvider`.
 *
 * `@luminaos/ui` must also be added as a runtime dependency of
 * `apps/web/package.json` for this import to resolve — it is not there yet.
 */

const THEME_STORAGE_KEY = 'luminaos-theme';

// Mirrors packages/ui/src/theme/ThemeProvider.test.tsx's mock helper — jsdom
// has no matchMedia implementation, and ThemeProvider's initial-theme
// resolution depends on it when nothing is persisted to localStorage.
function mockMatchMedia(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMatchMedia(false); // system preference: light, nothing persisted yet
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // App now renders real views (ListView by default) backed by apiClient's
  // fetch calls — stub a benign empty response so these theme-focused tests
  // don't depend on network/backend availability.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ objects: [] }) }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the LuminaOS heading', () => {
    // Wrapped in ThemeProvider (as main.tsx will in production) so that any
    // useTheme() call inside App's future theme-toggle control resolves
    // instead of throwing. The assertion itself is unchanged from before.
    renderApp();
    expect(screen.getByRole('heading', { name: 'LuminaOS' })).toBeInTheDocument();
  });

  it('renders a theme-toggle control as an accessible button (data-testid="theme-toggle")', () => {
    renderApp();

    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAccessibleName();
  });

  it('clicking the theme-toggle control flips document.documentElement.dataset.theme', async () => {
    const user = userEvent.setup();
    renderApp();

    // Default resolves to 'light' (mocked system preference, no persisted value).
    expect(document.documentElement.dataset.theme).toBe('light');

    await user.click(screen.getByTestId('theme-toggle'));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByTestId('theme-toggle'));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('renders the view switcher and defaults to the List view', async () => {
    renderApp();

    expect(screen.getByTestId('view-tab-list')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('list-view-empty')).toBeInTheDocument();
  });

  it('renders the create-object button', () => {
    renderApp();

    expect(screen.getByTestId('create-object-button')).toBeInTheDocument();
  });
});
