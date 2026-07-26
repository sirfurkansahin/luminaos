import { useDroppable } from '@dnd-kit/core';

import { BoardCard } from './BoardCard.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

export interface BoardColumnProps {
  groupValue: string;
  items: ObjectWithFieldValues[];
}

export function BoardColumn({ groupValue, items }: BoardColumnProps) {
  const { setNodeRef } = useDroppable({ id: groupValue });

  return (
    <div ref={setNodeRef} data-testid="board-column">
      <h3>{groupValue}</h3>
      <span>{items.length}</span>
      {items.map((object) => (
        <BoardCard key={object.id} object={object} />
      ))}
    </div>
  );
}
