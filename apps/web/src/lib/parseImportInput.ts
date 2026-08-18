/**
 * Parses raw pasted/uploaded input for the generic memory import wizard
 * (ADR-0023 §a). Tries three shapes in order, returning as soon as one
 * matches:
 *
 *   1. `raw` is valid JSON, parses to an array, and every element is an
 *      object carrying a literal `'schema:text'` string field -> returns
 *      those values, in order.
 *   2. `raw` is valid JSON, parses to an array, and every element is an
 *      object carrying a literal `content` string field -> returns those
 *      values, in order.
 *   3. Otherwise: treat `raw` as plain text — split on newlines, trim each
 *      line, drop empty lines.
 */
export function parseImportInput(raw: string): string[] {
  const parsed = tryParseJson(raw);

  if (Array.isArray(parsed)) {
    const schemaTextValues = extractStringField(parsed, 'schema:text');
    if (schemaTextValues !== null) {
      return schemaTextValues;
    }

    const contentValues = extractStringField(parsed, 'content');
    if (contentValues !== null) {
      return contentValues;
    }
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function extractStringField(items: unknown[], field: string): string[] | null {
  const values: string[] = [];

  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }

    const value = (item as Record<string, unknown>)[field];
    if (typeof value !== 'string') {
      return null;
    }

    values.push(value);
  }

  return values;
}
