export function computeFieldUpdate(
  groupField: string,
  objectId: string,
  sourceGroupValue: string,
  targetGroupValue: string | undefined,
): { objectId: string; values: Record<string, unknown> } | null {
  if (targetGroupValue === undefined || targetGroupValue === sourceGroupValue) {
    return null;
  }

  return { objectId, values: { [groupField]: targetGroupValue } };
}
