// Mirrors ../board/dragEndUpdate.ts's `computeFieldUpdate` shape/contract,
// but for a date-valued field (Calendar drag-and-drop, F1-T8 PR1) instead of
// a group field. See dragEndUpdate.test.ts for the full contract.

const DATE_LIKE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function extractDatePrefix(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE_LIKE_PREFIX.test(value)) {
    return undefined;
  }
  return value.slice(0, 10);
}

export function computeDateFieldUpdate(
  dateField: string,
  objectId: string,
  currentValue: unknown,
  targetDateISO: string,
): { objectId: string; values: Record<string, unknown> } | null {
  const currentDatePrefix = extractDatePrefix(currentValue);

  if (currentDatePrefix === targetDateISO) {
    return null;
  }

  const isDatetimeValue =
    typeof currentValue === 'string' && currentValue.length > 10 && currentDatePrefix !== undefined;

  const newValue = isDatetimeValue ? `${targetDateISO}${currentValue.slice(10)}` : targetDateISO;

  return { objectId, values: { [dateField]: newValue } };
}
