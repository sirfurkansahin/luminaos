import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { ChecklistItem } from '@luminaos/core-objects';

import {
  addChecklistItem,
  removeChecklistItem,
  reorderChecklistItem,
  toggleChecklistItem,
} from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { QueryKey } from '@tanstack/react-query';

// Each mutation's rollback context is deliberately SURGICAL — it remembers
// only what that specific mutation's own optimistic write changed, never a
// whole-object cache snapshot. A whole-object snapshot captured at this
// mutation's `onMutate` time would, on `onError`, unconditionally overwrite
// the ENTIRE cache — silently clobbering any OTHER mutation's
// server-confirmed result that landed in between (see
// `useSetFieldValuesMutation`'s own per-key rollback for the same reasoning
// applied to the flat field-value map). `onError` below always reads the
// CURRENT cache state and undoes only this mutation's own effect against it.
export interface AddItemContext {
  tempItemId: string;
}

export interface ToggleItemContext {
  itemId: string;
  previousDone: boolean;
}

export interface RemoveItemContext {
  removedItem: ChecklistItem | undefined;
}

export interface ReorderItemsContext {
  previousOrderedItemIds: string[];
}

// Narrower than the full `UseMutationResult<...>` shape react-query's own
// `useMutation()` returns (`mutate` required, the rest optional) —
// deliberately so, to structurally accept the real hook's actual
// `UseMutationResult` return value (a strict superset, always assignable to
// a narrower type). useChecklistMutations.test.ts reads `.mutate(...)`,
// `.isPending`, `.isSuccess`, `.isError` off each mutation, all covered here.
export interface ChecklistMutationHandle<TVariables> {
  mutate: (variables: TVariables) => void;
  isPending?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
}

export interface ChecklistMutations {
  addItem: ChecklistMutationHandle<{ text: string }>;
  toggleItem: ChecklistMutationHandle<{ itemId: string }>;
  removeItem: ChecklistMutationHandle<{ itemId: string }>;
  reorderItems: ChecklistMutationHandle<{ orderedItemIds: string[] }>;
}

/**
 * `ReturnType<typeof vi.fn>`, as used (unpinned, no explicit generic) by
 * ChecklistWidget.test.tsx's own `makeMutation()`/`mockMutations()` helpers
 * to build the wholesale `vi.mock('../../hooks/useChecklistMutations.js')`
 * replacement, resolves in this vitest version to a `Mock<Procedure |
 * Constructable>` type whose `Constructable` branch carries no call
 * signature at all — so no precise, directly-callable function type (what
 * `ChecklistMutations` above needs, since real callers invoke `.mutate(...)`
 * without a cast) is structurally assignable FROM that mock value. This
 * type exists purely so `vi.mocked(useChecklistMutations)`'s inferred
 * `mockReturnValue(...)` parameter type (computed from this exported
 * function's LAST overload signature, a well-documented TS behavior for
 * `ReturnType<>` on overloaded functions) is loose enough to accept that
 * mock's `{ mutate: vi.fn() }`-shaped literals without requiring a cast in
 * the test file. It is never used by any real call site.
 */
interface ChecklistMutationsMockCompatible {
  addItem: { mutate: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean };
  toggleItem: { mutate: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean };
  removeItem: { mutate: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean };
  reorderItems: { mutate: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean };
}

function generateTempItemId(): string {
  return `temp-${crypto.randomUUID()}`;
}

// Two overloads sharing an identical parameter list: real call expressions
// (this file's own implementation aside) always resolve to the FIRST
// matching overload, so every actual caller — ChecklistWidget.tsx,
// useChecklistMutations.test.ts's `renderHook(() => useChecklistMutations(...))`
// — sees the strict, directly-callable `ChecklistMutations` return type. The
// second overload only affects `ReturnType<>`-based type computations (see
// `ChecklistMutationsMockCompatible`'s own comment above).
export function useChecklistMutations(workspaceId: string, objectId: string): ChecklistMutations;
export function useChecklistMutations(
  workspaceId: string,
  objectId: string,
): ChecklistMutationsMockCompatible;
export function useChecklistMutations(workspaceId: string, objectId: string): ChecklistMutations {
  const queryClient = useQueryClient();
  const queryKey: QueryKey = ['object', workspaceId, objectId];

  function getCurrentChecklist(): ChecklistItem[] {
    const current = queryClient.getQueryData<{ object: ObjectWithFieldValues }>(queryKey);
    return current?.object.checklist ?? [];
  }

  function updateChecklist(
    computeNextChecklist: (checklist: ChecklistItem[]) => ChecklistItem[],
  ): void {
    queryClient.setQueryData<{ object: ObjectWithFieldValues }>(queryKey, (old) => {
      if (old === undefined) {
        return old;
      }
      return {
        ...old,
        object: { ...old.object, checklist: computeNextChecklist(old.object.checklist) },
      };
    });
  }

  const addItem = useMutation<
    { object: ObjectWithFieldValues },
    Error,
    { text: string },
    AddItemContext
  >({
    mutationFn: ({ text }) => addChecklistItem(workspaceId, objectId, text),
    onMutate: async ({ text }) => {
      await queryClient.cancelQueries({ queryKey });
      const tempItemId = generateTempItemId();
      updateChecklist((checklist) => [
        ...checklist,
        { id: tempItemId, text, done: false, order: checklist.length },
      ]);
      return { tempItemId };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      // Surgical undo: remove ONLY the item this mutation itself
      // optimistically added (matched by its own temp id), applied against
      // whatever the cache currently holds — not a stale whole-object
      // snapshot that could clobber other mutations' successful writes since.
      updateChecklist((checklist) => checklist.filter((item) => item.id !== context.tempItemId));
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  const toggleItem = useMutation<
    { object: ObjectWithFieldValues },
    Error,
    { itemId: string },
    ToggleItemContext
  >({
    mutationFn: ({ itemId }) => toggleChecklistItem(workspaceId, objectId, itemId),
    onMutate: async ({ itemId }) => {
      await queryClient.cancelQueries({ queryKey });
      const previousDone = getCurrentChecklist().find((item) => item.id === itemId)?.done ?? false;
      updateChecklist((checklist) =>
        checklist.map((item) => (item.id === itemId ? { ...item, done: !item.done } : item)),
      );
      return { itemId, previousDone };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      // Surgical undo: restore ONLY this item's `done` field to what it was
      // before this mutation's own optimistic flip, against the current
      // cache — other items (and any concurrent mutation's changes) untouched.
      updateChecklist((checklist) =>
        checklist.map((item) =>
          item.id === context.itemId ? { ...item, done: context.previousDone } : item,
        ),
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  const removeItem = useMutation<
    { object: ObjectWithFieldValues },
    Error,
    { itemId: string },
    RemoveItemContext
  >({
    mutationFn: ({ itemId }) => removeChecklistItem(workspaceId, objectId, itemId),
    onMutate: async ({ itemId }) => {
      await queryClient.cancelQueries({ queryKey });
      const removedItem = getCurrentChecklist().find((item) => item.id === itemId);
      updateChecklist((checklist) => checklist.filter((item) => item.id !== itemId));
      return { removedItem };
    },
    onError: (_error, _variables, context) => {
      if (context?.removedItem === undefined) {
        return;
      }
      const { removedItem } = context;
      // Surgical undo: re-insert ONLY the item this mutation itself removed,
      // against the current cache, re-sorted by the authoritative `order`
      // field. Exact position among neighbors changed by other concurrent
      // mutations since is a best-effort UX concern, not a correctness one —
      // the next successful mutation/refetch reconciles it.
      updateChecklist((checklist) => [...checklist, removedItem].sort((a, b) => a.order - b.order));
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  const reorderItems = useMutation<
    { object: ObjectWithFieldValues },
    Error,
    { orderedItemIds: string[] },
    ReorderItemsContext
  >({
    mutationFn: ({ orderedItemIds }) => reorderChecklistItem(workspaceId, objectId, orderedItemIds),
    onMutate: async ({ orderedItemIds }) => {
      await queryClient.cancelQueries({ queryKey });
      const previousOrderedItemIds = [...getCurrentChecklist()]
        .sort((a, b) => a.order - b.order)
        .map((item) => item.id);
      updateChecklist((checklist) =>
        orderedItemIds
          .map((itemId) => checklist.find((item) => item.id === itemId))
          .filter((item): item is ChecklistItem => item !== undefined)
          .map((item, index) => ({ ...item, order: index })),
      );
      return { previousOrderedItemIds };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      // Surgical undo: re-apply the PREVIOUS order captured by this
      // mutation's own onMutate to whichever items currently exist in the
      // cache (matched by id). Any item added/removed by another mutation
      // since simply isn't in the captured list — appended at the end (add)
      // or naturally excluded (remove) — rather than crashing or being lost.
      updateChecklist((checklist) => {
        const byId = new Map(checklist.map((item) => [item.id, item]));
        const reordered: ChecklistItem[] = [];
        for (const itemId of context.previousOrderedItemIds) {
          const item = byId.get(itemId);
          if (item !== undefined) {
            reordered.push(item);
            byId.delete(itemId);
          }
        }
        for (const item of byId.values()) {
          reordered.push(item);
        }
        return reordered.map((item, index) => ({ ...item, order: index }));
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  return { addItem, toggleItem, removeItem, reorderItems };
}
