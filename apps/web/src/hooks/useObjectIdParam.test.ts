import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useObjectIdParam } from './useObjectIdParam.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useObjectIdParam.ts to satisfy these tests. That's the
 * expected TDD red state.):
 *
 *   export function useObjectIdParam(): {
 *     objectId: string | undefined;
 *     openObject: (objectId: string) => void;
 *     closeObject: () => void;
 *   };
 *
 * Mirrors apps/web/src/hooks/useViewParam.ts's `useSyncExternalStore` +
 * `URLSearchParams` + `window.history.pushState`/`popstate` pattern, reading
 * the `?objectId=` query param from `window.location.search`. UNLIKE
 * `useViewParam` (which always has a value, defaulting to 'list'),
 * `objectId` has NO default/fallback: it is the literal string present in
 * the URL, or `undefined` when the param is absent.
 *
 * `openObject(next)` sets `?objectId=<next>` via `window.history.pushState`
 * (preserving any other existing query params, e.g. `?view=`) and the hook
 * re-renders with the new value.
 *
 * `closeObject()` REMOVES the `objectId` param entirely from the URL (not
 * just sets it to an empty string / sentinel) via
 * `URLSearchParams.prototype.delete` + `window.history.pushState`, again
 * preserving any other existing query params, and the hook re-renders back
 * to `objectId: undefined`.
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

describe('useObjectIdParam', () => {
  it('returns "abc" when the URL has ?objectId=abc', () => {
    setUrl('objectId=abc');

    const { result } = renderHook(() => useObjectIdParam());

    expect(result.current.objectId).toBe('abc');
  });

  it('returns undefined when no ?objectId param is present in the URL', () => {
    setUrl('');

    const { result } = renderHook(() => useObjectIdParam());

    expect(result.current.objectId).toBeUndefined();
  });

  it('openObject("xyz") sets ?objectId=xyz in the URL and the hook re-renders with the new value', () => {
    setUrl('');

    const { result } = renderHook(() => useObjectIdParam());
    expect(result.current.objectId).toBeUndefined();

    act(() => {
      result.current.openObject('xyz');
    });

    expect(window.location.search).toBe('?objectId=xyz');
    expect(result.current.objectId).toBe('xyz');
  });

  it('closeObject() removes the objectId param entirely (not just clears it) and the hook re-renders to undefined', () => {
    setUrl('objectId=xyz');

    const { result } = renderHook(() => useObjectIdParam());
    expect(result.current.objectId).toBe('xyz');

    act(() => {
      result.current.closeObject();
    });

    expect(window.location.search).toBe('');
    expect(window.location.search.includes('objectId')).toBe(false);
    expect(result.current.objectId).toBeUndefined();
  });

  it('openObject preserves other existing query params (e.g. ?view=board)', () => {
    setUrl('view=board');

    const { result } = renderHook(() => useObjectIdParam());

    act(() => {
      result.current.openObject('xyz');
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('view')).toBe('board');
    expect(params.get('objectId')).toBe('xyz');
  });

  it('closeObject preserves other existing query params (e.g. ?view=board) while removing objectId', () => {
    setUrl('view=board&objectId=xyz');

    const { result } = renderHook(() => useObjectIdParam());
    expect(result.current.objectId).toBe('xyz');

    act(() => {
      result.current.closeObject();
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('view')).toBe('board');
    expect(params.has('objectId')).toBe(false);
  });
});
