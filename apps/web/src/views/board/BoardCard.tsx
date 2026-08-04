import { useDraggable } from '@dnd-kit/core';

import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { CSSProperties, KeyboardEvent } from 'react';

export interface BoardCardProps {
  object: ObjectWithFieldValues;
}

export function BoardCard({ object }: BoardCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: object.id,
  });
  const { openObject } = useObjectIdParam();

  const style: CSSProperties = {
    transform:
      transform !== null
        ? `translate3d(${transform.x.toString()}px, ${transform.y.toString()}px, 0)`
        : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} data-testid="board-card" style={style} {...attributes} {...listeners}>
      <span
        data-testid="board-card-title"
        role="button"
        tabIndex={0}
        onClick={() => {
          openObject(object.id);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === 'Enter') {
            openObject(object.id);
          }
        }}
      >
        {object.title}
      </span>
    </div>
  );
}
