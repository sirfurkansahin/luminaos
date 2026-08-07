import { useDraggable } from '@dnd-kit/core';

import { Badge, Card } from '@luminaos/ui';

import styles from './CalendarView.module.css';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { CSSProperties } from 'react';

export interface CalendarObjectChipProps {
  object: ObjectWithFieldValues;
  // F1-T12 PR8a — read-only conflict marker (server-computed, per
  // ADR-0012): renders a second warning badge when `true`. Omitted entirely
  // (no element at all) when `false`/absent.
  hasConflict?: boolean;
}

export function CalendarObjectChip({ object, hasConflict }: CalendarObjectChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: object.id,
  });

  const style: CSSProperties = {
    transform:
      transform !== null
        ? `translate3d(${transform.x.toString()}px, ${transform.y.toString()}px, 0)`
        : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Card
      ref={setNodeRef}
      data-testid="calendar-object-chip"
      className={styles.chip}
      style={style}
      {...attributes}
      {...listeners}
    >
      <Badge>{object.title}</Badge>
      {hasConflict === true ? (
        <Badge variant="warning" data-testid="conflict-badge">
          ⚠
        </Badge>
      ) : null}
    </Card>
  );
}
