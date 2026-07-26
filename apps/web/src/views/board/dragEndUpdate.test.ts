import { describe, expect, it } from 'vitest';

import { computeFieldUpdate } from './dragEndUpdate.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/board/dragEndUpdate.ts to satisfy these tests. That's
 * the expected TDD red state.):
 *
 *   export function computeFieldUpdate(
 *     groupField: string,
 *     objectId: string,
 *     sourceGroupValue: string,
 *     targetGroupValue: string | undefined,
 *   ): { objectId: string; values: Record<string, unknown> } | null;
 *
 * A pure function (no @dnd-kit dependency) that turns a drag-end event's
 * raw source/target group values into the field-update payload the board
 * should PATCH — or `null` when no real move happened.
 *
 * - `targetGroupValue === undefined` (dropped outside any droppable column,
 *   i.e. the drag was effectively cancelled) -> null.
 * - `targetGroupValue === sourceGroupValue` (dropped back into the same
 *   column, no actual move) -> null.
 * - Otherwise -> `{ objectId, values: { [groupField]: targetGroupValue } }`.
 */

describe('computeFieldUpdate', () => {
  it('returns the field update payload when the card is dropped into a different column', () => {
    const result = computeFieldUpdate('status', 'obj-1', 'todo', 'done');

    expect(result).toEqual({
      objectId: 'obj-1',
      values: { status: 'done' },
    });
  });

  it('returns null when the card is dropped back into its source column (no real move)', () => {
    const result = computeFieldUpdate('status', 'obj-1', 'todo', 'todo');

    expect(result).toBeNull();
  });

  it('returns null when there is no drop target (drag cancelled or dropped outside any column)', () => {
    const result = computeFieldUpdate('status', 'obj-1', 'todo', undefined);

    expect(result).toBeNull();
  });
});
