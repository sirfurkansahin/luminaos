import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useColumnWidths } from './useColumnWidths.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/table/useColumnWidths.ts to satisfy these tests):
 *
 *   export function useColumnWidths(
 *     columnKeys: string[],
 *     defaultWidth?: number,
 *   ): {
 *     widths: Record<string, number>;
 *     setWidth: (columnKey: string, width: number) => void;
 *   };
 *
 * - Every key in `columnKeys` starts out at `defaultWidth` (or a sane
 *   built-in default, e.g. 150, when `defaultWidth` is omitted).
 * - `setWidth(columnKey, width)` updates only that column's width; all
 *   other columns are left untouched.
 * - A `width` of 0 or negative (an invalid drag) is clamped to a sane,
 *   positive minimum (implementer's choice, e.g. 40) rather than stored
 *   as-is.
 * - If the `columnKeys` array prop changes across a re-render (e.g. a new
 *   column is added), the new key gets `defaultWidth` while previously set
 *   widths for existing keys are preserved (not reset).
 */

describe('useColumnWidths', () => {
  it('returns the given defaultWidth for every column key on first render', () => {
    const { result } = renderHook(() => useColumnWidths(['title', 'status', 'assignee'], 200));

    expect(result.current.widths).toEqual({
      title: 200,
      status: 200,
      assignee: 200,
    });
  });

  it('falls back to a sane built-in default width when defaultWidth is omitted', () => {
    const { result } = renderHook(() => useColumnWidths(['title', 'status']));

    expect(result.current.widths.title).toBeGreaterThan(0);
    expect(result.current.widths.title).toBe(result.current.widths.status);
  });

  it('setWidth updates only the targeted column, leaving others unchanged', () => {
    const { result } = renderHook(() => useColumnWidths(['title', 'status', 'assignee'], 150));

    act(() => {
      result.current.setWidth('status', 260);
    });

    expect(result.current.widths).toEqual({
      title: 150,
      status: 260,
      assignee: 150,
    });
  });

  it('clamps a zero or negative width to a positive minimum instead of storing it as-is', () => {
    const { result } = renderHook(() => useColumnWidths(['title'], 150));

    act(() => {
      result.current.setWidth('title', 0);
    });
    expect(result.current.widths.title).toBeGreaterThan(0);

    act(() => {
      result.current.setWidth('title', -50);
    });
    expect(result.current.widths.title).toBeGreaterThan(0);
  });

  it('adds a newly-appearing column key at defaultWidth while preserving existing widths when columnKeys changes', () => {
    const { result, rerender } = renderHook(
      ({ columnKeys }: { columnKeys: string[] }) => useColumnWidths(columnKeys, 150),
      { initialProps: { columnKeys: ['title', 'status'] } },
    );

    act(() => {
      result.current.setWidth('title', 300);
    });
    expect(result.current.widths).toEqual({ title: 300, status: 150 });

    rerender({ columnKeys: ['title', 'status', 'assignee'] });

    expect(result.current.widths).toEqual({
      title: 300,
      status: 150,
      assignee: 150,
    });
  });
});
