import { useDraggable } from '@dnd-kit/core';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalEventChip } from './ExternalEventChip.js';

import type { ExternalCalendarEvent } from '../../lib/apiClient.js';

/**
 * F1-T12 PR8a — TDD red step. Contract under test (not yet implemented —
 * implementer must create apps/web/src/views/calendar/ExternalEventChip.tsx):
 *
 *   export interface ExternalEventChipProps { event: ExternalCalendarEvent }
 *   export function ExternalEventChip(props: ExternalEventChipProps): React.JSX.Element;
 *
 * Read-only — per ADR-0012 §a/§b (one-way external-calendar sync), an
 * external event can NEVER be dragged/rescheduled from LuminaOS, so this
 * component must NOT call `useDraggable` at all (unlike CalendarObjectChip).
 * Renders `<Card data-testid="external-event-chip">` containing the event's
 * title (e.g. via a neutral `Badge`).
 *
 * `@dnd-kit/core` is mocked wholesale here (mirrors CalendarObjectChip.test's
 * convention) purely so `useDraggable`'s call count can be asserted as zero —
 * it is NOT expected to be invoked by this component.
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

const mockedUseDraggable = vi.mocked(useDraggable);

afterEach(() => {
  vi.clearAllMocks();
});

function makeEvent(overrides: Partial<ExternalCalendarEvent> = {}): ExternalCalendarEvent {
  return {
    externalId: 'ext-1',
    title: 'Doktor randevusu',
    start: '2026-08-05T10:00:00.000Z',
    end: '2026-08-05T10:30:00.000Z',
    ...overrides,
  };
}

describe('ExternalEventChip', () => {
  it('renders data-testid="external-event-chip" containing the event title', () => {
    render(<ExternalEventChip event={makeEvent({ title: 'Diş hekimi' })} />);

    const chip = screen.getByTestId('external-event-chip');
    expect(chip).toHaveTextContent('Diş hekimi');
  });

  it('never calls useDraggable — external events are never draggable/reschedulable', () => {
    render(<ExternalEventChip event={makeEvent()} />);

    expect(mockedUseDraggable).not.toHaveBeenCalled();
  });
});
