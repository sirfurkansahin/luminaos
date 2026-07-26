import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useViewParam } from './useViewParam.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useViewParam.ts to satisfy these tests):
 *
 *   export type ViewKind = 'list' | 'board' | 'table';
 *
 *   export function useViewParam(): {
 *     view: ViewKind;
 *     setView: (next: ViewKind) => void;
 *   };
 *
 * Reads the current view from the URL's `?view=` query param
 * (`window.location.search`). When the param is absent, or holds anything
 * other than exactly 'list' | 'board' | 'table', the hook falls back to the
 * default 'list'. `setView(next)` updates the URL via
 * `window.history.pushState` (no full page navigation/reload, no external
 * router dependency — CLAUDE.md domain-purity aside, this hook itself lives
 * in apps/web so React-only, no extra libs is a design choice, not a hard
 * rule) so that a subsequent read of `window.location.search` reflects
 * `?view=<next>`, and the hook itself re-renders with the new value.
 */

function setUrl(query: string): void {
  const search = query.replace(/^\?/, '');
  const url = search.length > 0 ? `/?${search}` : '/';
  window.history.pushState({}, '', url);
}

beforeEach(() => {
  setUrl('');
});

afterEach(() => {
  setUrl('');
});

describe('useViewParam', () => {
  it('returns "board" when the URL has ?view=board', () => {
    setUrl('view=board');

    const { result } = renderHook(() => useViewParam());

    expect(result.current.view).toBe('board');
  });

  it('defaults to "list" when no ?view param is present in the URL', () => {
    setUrl('');

    const { result } = renderHook(() => useViewParam());

    expect(result.current.view).toBe('list');
  });

  it('defaults to "list" when ?view holds a value outside list|board|table', () => {
    setUrl('view=kanban');

    const { result } = renderHook(() => useViewParam());

    expect(result.current.view).toBe('list');
  });

  it('setView("table") updates window.location.search to "?view=table"', () => {
    setUrl('');

    const { result } = renderHook(() => useViewParam());

    act(() => {
      result.current.setView('table');
    });

    expect(window.location.search).toBe('?view=table');
  });

  it('setView(...) re-renders the hook so result.current.view reflects the new value', () => {
    setUrl('view=list');

    const { result } = renderHook(() => useViewParam());
    expect(result.current.view).toBe('list');

    act(() => {
      result.current.setView('board');
    });

    expect(result.current.view).toBe('board');
  });
});
