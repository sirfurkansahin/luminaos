import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedValue } from './useDebouncedValue.js';

/**
 * F1-T13 PR6 (ADR-0013) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/hooks/useDebouncedValue.ts to satisfy these tests):
 *
 *   export function useDebouncedValue<T>(value: T, delayMs: number): T;
 *
 * A GENERIC, reusable "debounce a changing value" hook — no dependency on
 * search. PR7's command palette will use it for its 250ms search-input
 * debounce, but that is a caller detail, not part of this hook's contract.
 *
 * Fake-timer setup/teardown mirrors this repo's own convention
 * (apps/web/src/lib/dateMath.test.ts's `getTodayDateOnly` describe block):
 * `beforeEach(() => vi.useFakeTimers())` / `afterEach(() => vi.useRealTimers())`.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedValue', () => {
  it('returns the initial value immediately on first render, with no debounce delay', () => {
    const { result } = renderHook(() => useDebouncedValue('initial', 250));

    expect(result.current).toBe('initial');
  });

  it('does not update the returned value immediately when the input value changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'b' });

    expect(result.current).toBe('a');
  });

  it('updates the returned value to the new value once delayMs has elapsed after a change', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'b' });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe('b');
  });

  it('restarts the debounce timer on each change and never transiently shows an intermediate value', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });

    // Change to 'b', advance less than delayMs.
    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('a');

    // Change to 'c' before 'b''s debounce fired — timer must restart, not
    // fire on 'b'.
    rerender({ value: 'c' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('a');

    // Only after a FULL delayMs has elapsed since the LAST change ('c') does
    // the value update — and it jumps straight to 'c', never 'b'.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe('c');
  });

  it('honors different delayMs values independently (e.g. 100ms updates after exactly 100ms)', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'z' });

    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('z');
  });
});
