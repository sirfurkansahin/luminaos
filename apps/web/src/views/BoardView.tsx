import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useMemo, useState } from 'react';

import type { QuerySpec } from '@luminaos/shared';
import { EmptyState, Skeleton } from '@luminaos/ui';

import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';
import { BoardColumn } from './board/BoardColumn.js';
import { computeFieldUpdate } from './board/dragEndUpdate.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { DragEndEvent } from '@dnd-kit/core';

export interface BoardViewProps {
  workspaceId: string;
  querySpec: QuerySpec;
}

export function BoardView({ workspaceId, querySpec }: BoardViewProps) {
  const { data, isLoading, isError } = useObjectsQuery(workspaceId, querySpec);
  const mutation = useSetFieldValuesMutation(workspaceId);
  const groupField = querySpec.group;

  const baseGroups = useMemo(
    () => (data !== undefined && 'groups' in data ? data.groups : []),
    [data],
  );

  // Optimistic column placement — independent of the shared mutation's own
  // cache-level optimism (that hook only understands the flat `{ objects }`
  // query shape, not this view's `{ groups }` shape). Board shares a single
  // `useSetFieldValuesMutation` instance across every card, so more than one
  // drag can be in flight at once (e.g. drop card A, then immediately drag
  // card B before A's request settles) — the shared mutation's own
  // `isError`/`isSuccess` can't tell which object it belongs to. Rollback is
  // therefore scoped per-drag via `mutate`'s own per-call `onError`
  // callback, never the mutation's global status.
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const effectiveGroups = useMemo(() => {
    if (Object.keys(overrides).length === 0) {
      return baseGroups;
    }

    const byGroup = new Map<string, ObjectWithFieldValues[]>();
    for (const group of baseGroups) {
      byGroup.set(group.groupValue, []);
    }
    for (const group of baseGroups) {
      for (const item of group.items) {
        const effectiveGroupValue = overrides[item.id] ?? group.groupValue;
        byGroup.get(effectiveGroupValue)?.push(item);
      }
    }

    return baseGroups.map((group) => ({
      ...group,
      items: byGroup.get(group.groupValue) ?? [],
    }));
  }, [baseGroups, overrides]);

  function findEffectiveGroupValue(objectId: string): string | undefined {
    if (objectId in overrides) {
      return overrides[objectId];
    }
    for (const group of baseGroups) {
      if (group.items.some((item) => item.id === objectId)) {
        return group.groupValue;
      }
    }
    return undefined;
  }

  const handleDragEnd = (event: DragEndEvent): void => {
    if (groupField === undefined) {
      return;
    }
    const objectId = String(event.active.id);
    const sourceGroupValue = findEffectiveGroupValue(objectId);
    if (sourceGroupValue === undefined) {
      return;
    }
    const targetGroupValue = event.over !== null ? String(event.over.id) : undefined;
    const update = computeFieldUpdate(groupField, objectId, sourceGroupValue, targetGroupValue);
    if (update === null) {
      return;
    }

    const newGroupValue = update.values[groupField] as string;
    setOverrides((prev) => ({ ...prev, [objectId]: newGroupValue }));
    mutation.mutate(update, {
      onError: () => {
        setOverrides((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([key]) => key !== objectId)),
        );
      },
    });
  };

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  // See ListView.tsx's comment: `isLoading` alone misses the gap between
  // retry attempts (isFetching briefly false, isError not yet true).
  if (isLoading || (data === undefined && !isError)) {
    return (
      <div data-testid="board-view-loading">
        <Skeleton height={200} />
        <Skeleton height={200} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="board-view-error"
        title="Bir hata oluştu"
        description="Nesneler yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  if (effectiveGroups.length === 0) {
    return (
      <EmptyState
        data-testid="board-view-empty"
        title="Henüz nesne yok"
        description="İlk nesneni oluşturarak başla."
      />
    );
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      {effectiveGroups.map((group) => (
        <BoardColumn key={group.groupValue} groupValue={group.groupValue} items={group.items} />
      ))}
    </DndContext>
  );
}
