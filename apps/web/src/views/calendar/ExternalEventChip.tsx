import { Badge, Card } from '@luminaos/ui';

import styles from './CalendarView.module.css';

import type { ExternalCalendarEvent } from '../../lib/apiClient.js';

// F1-T12 PR8a — read-only external-calendar sync (ADR-0012 §a/§b): an
// external event can NEVER be dragged/rescheduled from LuminaOS, so unlike
// CalendarObjectChip this component deliberately does NOT call
// `useDraggable`.
export interface ExternalEventChipProps {
  event: ExternalCalendarEvent;
}

export function ExternalEventChip({ event }: ExternalEventChipProps) {
  return (
    <Card data-testid="external-event-chip" className={styles.chip}>
      <Badge variant="neutral">{event.title}</Badge>
    </Card>
  );
}
