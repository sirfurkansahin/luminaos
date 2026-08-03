// Detects which `fieldValues` keys look like `date`/`datetime` custom-field
// values, for the Calendar/Timeline "which field drives the grid" bootstrap
// selection (see docs/specs/F1-E2/F1-T8-calendar-timeline.md). No schema
// endpoint exists yet, so this scans real sample values instead — mirroring
// TableView's existing "derive shape from the first page" pattern.

const DATE_LIKE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

export function detectDateFieldCandidates(
  objects: Array<{ fieldValues: Record<string, unknown> }>,
): string[] {
  const candidates = new Set<string>();

  for (const object of objects) {
    for (const [key, value] of Object.entries(object.fieldValues)) {
      if (typeof value === 'string' && DATE_LIKE_PREFIX.test(value)) {
        candidates.add(key);
      }
    }
  }

  return Array.from(candidates).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
