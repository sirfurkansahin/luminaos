import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

import { ThemeContext, type Theme } from './ThemeContext.js';

const THEME_STORAGE_KEY = 'luminaos-theme';

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark';
}

function resolveInitialTheme(): Theme {
  const persisted = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (isTheme(persisted)) {
    return persisted;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === 'light' ? 'dark' : 'light';
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
