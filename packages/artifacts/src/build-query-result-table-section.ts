import type { ArtifactSection } from './artifact-content.js';

// ADR-0042 Karar (h): a live query widget's table renders at most this many
// rows...
export const MAX_WIDGET_TABLE_ROWS = 25;
// ...and each cell is truncated to at most this many characters (consistent
// with `artifactSectionSchema`'s `table.rows` cell cap in artifact-content.ts).
export const MAX_WIDGET_CELL_LENGTH = 500;

interface QueryResultRow {
  title: string;
  fieldValues: Record<string, unknown>;
}

// `value` is a non-null/non-undefined, non-array primitive read straight
// from `row.fieldValues` (an untyped bag) -- narrowing to `unknown` object
// shapes explicitly here (rather than a blind `String(value)` on the raw
// `unknown`) keeps this call safe from the linter's base-to-string check
// while still honoring the contract's "anything else -> String(value)" rule.
function stringifyPrimitive(value: object | string | number | boolean | bigint | symbol): string {
  return typeof value === 'object' ? Object.prototype.toString.call(value) : String(value);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.join(', ').slice(0, MAX_WIDGET_CELL_LENGTH);
  }

  return stringifyPrimitive(value).slice(0, MAX_WIDGET_CELL_LENGTH);
}

function readCell(row: QueryResultRow, column: string): unknown {
  return column === 'title' ? row.title : row.fieldValues[column];
}

/** PURE -- no I/O. Builds an `ArtifactSection` (`kind: 'table'`) from raw
 * query result rows and a derived column set (see `deriveWidgetColumns`),
 * truncating rows/cells per ADR-0042 Karar (h). Every cell value is later
 * escaped for HTML by `renderArtifactHtml` -- this function only stringifies,
 * it never escapes. */
export function buildQueryResultTableSection(
  rows: QueryResultRow[],
  columns: string[],
): ArtifactSection {
  const truncatedRows = rows.slice(0, MAX_WIDGET_TABLE_ROWS);

  return {
    kind: 'table',
    headers: columns,
    rows: truncatedRows.map((row) => columns.map((column) => stringifyCell(readCell(row, column)))),
  };
}
