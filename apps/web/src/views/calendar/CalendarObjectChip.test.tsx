import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CalendarObjectChip } from './CalendarObjectChip.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

/**
 * F1-T12 PR8a — TDD red step. Contract under test (not yet implemented —
 * implementer must add an optional `hasConflict?: boolean` prop to
 * `CalendarObjectChipProps` in CalendarObjectChip.tsx):
 *
 *   export interface CalendarObjectChipProps {
 *     object: ObjectWithFieldValues;
 *     hasConflict?: boolean;
 *   }
 *
 * When `hasConflict === true`, an EXTRA warning badge renders inside the
 * `Card`, alongside the existing title `Badge`:
 *   <Badge variant="warning" data-testid="conflict-badge">⚠</Badge>
 * When `false` or omitted, no element with that testid renders at all — this
 * PR does not add any drag/write behavior, only a read-only visual marker.
 */

vi.mock('@dnd-kit/core', () => ({
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeObject(id: string, title = `Object ${id}`): ObjectWithFieldValues {
  return { id, title, fieldValues: {} } as unknown as ObjectWithFieldValues;
}

describe('CalendarObjectChip', () => {
  it('renders the conflict badge (data-testid="conflict-badge") when hasConflict is true', () => {
    render(<CalendarObjectChip object={makeObject('obj-1')} hasConflict />);

    expect(screen.getByTestId('conflict-badge')).toBeInTheDocument();
  });

  it('does not render the conflict badge when hasConflict is false', () => {
    render(<CalendarObjectChip object={makeObject('obj-1')} hasConflict={false} />);

    expect(screen.queryByTestId('conflict-badge')).not.toBeInTheDocument();
  });

  it('does not render the conflict badge when hasConflict is omitted', () => {
    render(<CalendarObjectChip object={makeObject('obj-1')} />);

    expect(screen.queryByTestId('conflict-badge')).not.toBeInTheDocument();
  });

  it('still renders the existing calendar-object-chip root and title badge unaffected', () => {
    render(<CalendarObjectChip object={makeObject('obj-1', 'Bildirim gönder')} />);

    const chip = screen.getByTestId('calendar-object-chip');
    expect(chip).toHaveTextContent('Bildirim gönder');
  });
});
