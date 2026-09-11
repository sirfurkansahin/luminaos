import type { QuerySpec } from '@luminaos/shared';

// ADR-0042 Karar (g): a live query widget's table renders at most this many
// columns, "title" always occupying the first slot.
export const MAX_WIDGET_TABLE_COLUMNS = 8;

/** PURE -- no I/O. Derives the widget table's column set from a QuerySpec:
 * "title" first, then the distinct fields referenced by `filters` and
 * `sort` (in that order, first-seen wins), truncated to
 * `MAX_WIDGET_TABLE_COLUMNS`. */
export function deriveWidgetColumns(querySpec: QuerySpec): string[] {
  const referenced = [
    'title',
    ...querySpec.filters.map((filter) => filter.field),
    ...(querySpec.sort ?? []).map((sort) => sort.field),
  ];

  return Array.from(new Set(referenced)).slice(0, MAX_WIDGET_TABLE_COLUMNS);
}
