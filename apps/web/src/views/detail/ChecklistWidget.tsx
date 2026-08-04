import { useState } from 'react';

import type { ChecklistItem } from '@luminaos/core-objects';
import { Button, Checkbox, Input } from '@luminaos/ui';

import { useChecklistMutations } from '../../hooks/useChecklistMutations.js';

export interface ChecklistWidgetProps {
  workspaceId: string;
  objectId: string;
  items: ChecklistItem[];
}

export function ChecklistWidget({ workspaceId, objectId, items }: ChecklistWidgetProps) {
  const { addItem, toggleItem, removeItem, reorderItems } = useChecklistMutations(
    workspaceId,
    objectId,
  );
  const [draft, setDraft] = useState('');

  const sortedItems = [...items].sort((a, b) => a.order - b.order);

  function submitDraft(): void {
    const text = draft.trim();
    if (text === '') {
      return;
    }
    addItem.mutate({ text });
    setDraft('');
  }

  function moveItem(index: number, direction: -1 | 1): void {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sortedItems.length) {
      return;
    }
    const orderedItemIds = sortedItems.map((item) => item.id);
    const currentId = orderedItemIds[index] as string;
    const targetId = orderedItemIds[targetIndex] as string;
    orderedItemIds[index] = targetId;
    orderedItemIds[targetIndex] = currentId;
    reorderItems.mutate({ orderedItemIds });
  }

  return (
    <div>
      {sortedItems.map((item, index) => {
        const isOptimistic = item.id.startsWith('temp-');
        return (
          <div key={item.id} data-testid={`checklist-item-${item.id}`}>
            <Checkbox
              data-testid={`checklist-item-checkbox-${item.id}`}
              aria-label={item.text}
              checked={item.done}
              disabled={isOptimistic}
              onCheckedChange={() => {
                toggleItem.mutate({ itemId: item.id });
              }}
            />
            <span>{item.text}</span>
            <Button
              type="button"
              data-testid={`checklist-item-move-up-${item.id}`}
              disabled={isOptimistic || index === 0}
              onClick={() => {
                moveItem(index, -1);
              }}
            >
              Yukarı taşı
            </Button>
            <Button
              type="button"
              data-testid={`checklist-item-move-down-${item.id}`}
              disabled={isOptimistic || index === sortedItems.length - 1}
              onClick={() => {
                moveItem(index, 1);
              }}
            >
              Aşağı taşı
            </Button>
            <Button
              type="button"
              data-testid={`checklist-item-remove-${item.id}`}
              disabled={isOptimistic}
              onClick={() => {
                removeItem.mutate({ itemId: item.id });
              }}
            >
              Kaldır
            </Button>
          </div>
        );
      })}
      <Input
        data-testid="checklist-add-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitDraft();
          }
        }}
      />
      <Button
        type="button"
        data-testid="checklist-add-button"
        onClick={() => {
          submitDraft();
        }}
      >
        Ekle
      </Button>
    </div>
  );
}
