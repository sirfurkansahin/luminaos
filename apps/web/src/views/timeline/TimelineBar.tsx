// A single object's horizontal bar row in the Timeline canvas. No
// drag-and-drop here (unlike Calendar's chips) — Timeline's acceptance
// criteria only cover positioning/rendering, not date-editing via drag.

import { Badge, Card } from '@luminaos/ui';

import styles from './TimelineView.module.css';

import type { TimelineBar as TimelineBarLayout } from './timelineLayout.js';
import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

export interface TimelineBarProps {
  object: ObjectWithFieldValues;
  layout: TimelineBarLayout;
  registerRef: (element: HTMLDivElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function TimelineBar({ object, layout, registerRef, onKeyDown }: TimelineBarProps) {
  const className = [
    styles.bar,
    layout.clampedStart || layout.clampedEnd ? styles.barClamped : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Card
      ref={registerRef}
      role="listitem"
      tabIndex={0}
      data-testid="timeline-bar"
      data-object-id={object.id}
      className={className}
      style={{ left: layout.left, width: layout.width }}
      onKeyDown={onKeyDown}
    >
      <Badge>{object.title}</Badge>
    </Card>
  );
}
