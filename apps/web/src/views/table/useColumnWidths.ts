import { useCallback, useMemo, useState } from 'react';

const DEFAULT_COLUMN_WIDTH = 150;
const MIN_COLUMN_WIDTH = 40;

export function useColumnWidths(
  columnKeys: string[],
  defaultWidth: number = DEFAULT_COLUMN_WIDTH,
): { widths: Record<string, number>; setWidth: (columnKey: string, width: number) => void } {
  // Only explicit overrides are tracked in state — a column with no override
  // simply falls back to `defaultWidth` on every render, so a newly-added
  // `columnKeys` entry needs no special handling and existing overrides are
  // never disturbed by that change.
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  const widths = useMemo(() => {
    const result: Record<string, number> = {};
    for (const key of columnKeys) {
      result[key] = overrides[key] ?? defaultWidth;
    }
    return result;
  }, [columnKeys, defaultWidth, overrides]);

  const setWidth = useCallback((columnKey: string, width: number) => {
    const clampedWidth = width > 0 ? width : MIN_COLUMN_WIDTH;
    setOverrides((prev) => ({ ...prev, [columnKey]: clampedWidth }));
  }, []);

  return { widths, setWidth };
}
