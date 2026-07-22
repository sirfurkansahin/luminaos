import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from './ThemeProvider.js';
import { useTheme } from './useTheme.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/theme/ThemeProvider.tsx and packages/ui/src/theme/useTheme.ts
 * to satisfy these tests):
 *
 * - `Theme` = 'light' | 'dark'.
 * - `ThemeProvider({ children }: { children: React.ReactNode })` is a React context
 *   provider. On mount it resolves the *initial* theme with this priority:
 *     1. A previously persisted value in `localStorage` under the key
 *        `'luminaos-theme'` — IF it is present and is exactly `'light'` or `'dark'`.
 *     2. Otherwise, the OS preference via
 *        `window.matchMedia('(prefers-color-scheme: dark)').matches`
 *        (`true` -> 'dark', `false` -> 'light').
 *   The resolved theme is written to `document.documentElement.dataset.theme`
 *   (i.e. the `data-theme` attribute on `<html>`).
 * - `useTheme()` is a hook that must be called within a `ThemeProvider`. It returns:
 *     `{ theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void }`
 *   Calling `setTheme(next)` or `toggleTheme()`:
 *     - updates `document.documentElement.dataset.theme` to the new value
 *     - persists the new value via `localStorage.setItem('luminaos-theme', next)`
 *     - re-renders consumers with the new `theme` value
 * - Calling `useTheme()` outside of a `ThemeProvider` throws (standard React
 *   context guard — e.g. `throw new Error('useTheme must be used within a ThemeProvider')`).
 *
 * IMPORTANT for implementer: the localStorage key MUST be exactly `'luminaos-theme'`
 * — these tests assert against that literal key.
 */

const THEME_STORAGE_KEY = 'luminaos-theme';

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

function ThemeConsumer() {
  const { theme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button
        onClick={() => {
          setTheme('dark');
        }}
      >
        set-dark
      </button>
      <button
        onClick={() => {
          toggleTheme();
        }}
      >
        toggle
      </button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThemeProvider', () => {
  it('defaults to light when system preference is light and nothing is persisted', () => {
    mockMatchMedia(false);

    render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('defaults to dark when system preference is dark and nothing is persisted', () => {
    mockMatchMedia(true);

    render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('lets a consumer read theme/setTheme/toggleTheme via useTheme()', () => {
    mockMatchMedia(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('theme-value')).toHaveTextContent('light');
  });

  it('setTheme updates document.documentElement.dataset.theme and persists to localStorage', async () => {
    mockMatchMedia(false);
    const user = userEvent.setup();

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'set-dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByTestId('theme-value')).toHaveTextContent('dark');
  });

  it('toggleTheme flips the theme and persists it', async () => {
    mockMatchMedia(false);
    const user = userEvent.setup();

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('theme-value')).toHaveTextContent('light');

    await user.click(screen.getByRole('button', { name: 'toggle' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('honors a persisted preference over the system default on a fresh mount', () => {
    // System says light, but a previous session persisted 'dark' — persisted wins.
    mockMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByTestId('theme-value')).toHaveTextContent('dark');
  });

  it('throws a clear error when useTheme() is called outside a ThemeProvider', () => {
    // Suppress the expected React error-boundary console.error noise for this
    // intentionally-failing render.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useTheme())).toThrow();

    consoleErrorSpy.mockRestore();
  });
});
