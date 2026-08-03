import { useDraggable } from '@dnd-kit/core';

import { Badge, Card } from '@luminaos/ui';

import styles from './CalendarView.module.css';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { CSSProperties } from 'react';

export interface CalendarObjectChipProps {
  object: ObjectWithFieldValues;
}

export function CalendarObjectChip({ object }: CalendarObjectChipProps) {
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
    </Card>
  );
}
