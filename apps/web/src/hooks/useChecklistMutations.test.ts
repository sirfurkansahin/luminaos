import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChecklistItem } from '@luminaos/core-objects';

import { useChecklistMutations } from './useChecklistMutations.js';
import {
  addChecklistItem,
  removeChecklistItem,
  reorderChecklistItem,
  toggleChecklistItem,
} from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useChecklistMutations.ts to satisfy these tests. That's
 * the expected TDD red state — this file fails to even resolve its own
 * `./useChecklistMutations.js` import until the hook exists. It also imports
 * four apiClient.ts exports (`addChecklistItem`, `toggleChecklistItem`,
 * `removeChecklistItem`, `reorderChecklistItem`) that do not exist there yet
 * either — mocked wholesale below via `vi.mock`, mirroring
 * useObjectsQuery.test.ts's `patchFieldValues`/`postObjectsQuery` mocking
 * style — but until apiClient.ts actually exports them, this file also fails
 * TypeScript resolution/typecheck. Both gaps are `implementer`'s job, not
 * test-writer's.
 *
 *   export function addChecklistItem(workspaceId: string, objectId: string, text: string):
 *     Promise<{ object: ObjectWithFieldValues }>;   // POST .../checklist/items { text }
 *   export function toggleChecklistItem(workspaceId: string, objectId: string, itemId: string):
 *     Promise<{ object: ObjectWithFieldValues }>;   // POST .../checklist/items/:itemId/toggle
 *   export function removeChecklistItem(workspaceId: string, objectId: string, itemId: string):
 *     Promise<{ object: ObjectWithFieldValues }>;   // DELETE .../checklist/items/:itemId
 *   export function reorderChecklistItem(
 *     workspaceId: string, objectId: string, orderedItemIds: string[],
 *   ): Promise<{ object: ObjectWithFieldValues }>;  // POST .../checklist/reorder { orderedItemIds }
 *
 *   export interface ChecklistMutations {
 *     addItem: UseMutationResult<{ object: ObjectWithFieldValues }, Error, { text: string }, ChecklistOptimisticContext>;
 *     toggleItem: UseMutationResult<{ object: ObjectWithFieldValues }, Error, { itemId: string }, ChecklistOptimisticContext>;
 *     removeItem: UseMutationResult<{ object: ObjectWithFieldValues }, Error, { itemId: string }, ChecklistOptimisticContext>;
 *     reorderItems: UseMutationResult<{ object: ObjectWithFieldValues }, Error, { orderedItemIds: string[] }, ChecklistOptimisticContext>;
 *   }
 *   export function useChecklistMutations(workspaceId: string, objectId: string): ChecklistMutations;
 *
 * DESIGN DECISION — one hook, four mutations, one shared cache entry: unlike
 * `useSetFieldValuesMutation` (one hook per action, operating over the
 * flat-map `['objects', workspaceId, ...]` list cache with per-key rollback),
 * checklist mutations all target the SAME single cache entry
 * (`['object', workspaceId, objectId]`, the same key `useObjectQuery` reads,
 * shape `{ object: ObjectWithFieldValues }`) and all mutate the SAME embedded
 * `checklist: ChecklistItem[]` array on it. Bundling all four into one hook
 * call (rather than four separate exported hooks) lets `ChecklistWidget`
 * obtain everything it needs — and share one `queryClient`/`queryKey`
 * closure — from a single call site, mirroring how `TaskDetailPanel` already
 * gets `{ data, isLoading, isError }` from one `useObjectQuery` call rather
 * than three separate hooks.
 *
 * Every mutation's `onMutate` snapshots the current `{ object }` cache entry
 * (`context.previousObject`) and locally computes+writes the EXPECTED next
 * `checklist` array — mirroring packages/core-objects/src/
 * checklist-commands.ts's exact fold semantics (read in full for this PR):
 *   - addItem: appends `{ id: <locally-generated temp id, distinct from any
 *     real server id>, text, done: false, order: <current checklist length> }`.
 *   - toggleItem: flips the matching item's `done`.
 *   - removeItem: filters the matching item out.
 *   - reorderItems: resequences the checklist into the given
 *     `orderedItemIds` order, with `order` reassigned 0..n-1 positionally.
 * `onError` restores `context.previousObject` verbatim (snapshot-based
 * rollback — simpler than useSetFieldValuesMutation's per-key rollback since
 * this is one embedded array, not a flat field map). `onSuccess` replaces the
 * cache with the mutationFn's own resolved `{ object }` (the server's real,
 * settled state — e.g. addItem's real server-generated itemId replacing the
 * optimistic temp id).
 */

vi.mock('../lib/apiClient.js', () => ({
  addChecklistItem: vi.fn(),
  toggleChecklistItem: vi.fn(),
  removeChecklistItem: vi.fn(),
  reorderChecklistItem: vi.fn(),
}));

const mockedAddChecklistItem = vi.mocked(addChecklistItem);
const mockedToggleChecklistItem = vi.mocked(toggleChecklistItem);
const mockedRemoveChecklistItem = vi.mocked(removeChecklistItem);
const mockedReorderChecklistItem = vi.mocked(reorderChecklistItem);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { queryClient, Wrapper };
}

const workspaceId = 'ws-1';
const objectId = 'obj-1';
const queryKey = ['object', workspaceId, objectId] as const;

function makeChecklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id: 'item-1', text: 'Write tests', done: false, order: 0, ...overrides };
}

function makeObject(checklist: ChecklistItem[]): { object: ObjectWithFieldValues } {
  return {
    object: {
      id: objectId,
      type: 'task',
      workspaceId,
      title: 'Ship PR6f',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      lifecycle: 'active',
      checklist,
      fieldValues: {},
    } as unknown as ObjectWithFieldValues,
  };
}

function seedCache(
  queryClient: QueryClient,
  checklist: ChecklistItem[],
): { object: ObjectWithFieldValues } {
  const payload = makeObject(checklist);
  queryClient.setQueryData(queryKey, payload);
  return payload;
}

function readCachedChecklist(queryClient: QueryClient): ChecklistItem[] {
  const cached = queryClient.getQueryData<{ object: ObjectWithFieldValues }>(queryKey);
  return cached?.object.checklist ?? [];
}

function pendingPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error('resolve called before assignment');
  };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useChecklistMutations — addItem', () => {
  it('calls apiClient.addChecklistItem with the workspace id, object id and text on mutate', async () => {
    mockedAddChecklistItem.mockResolvedValueOnce(makeObject([makeChecklistItem()]));
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, []);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.addItem.mutate({ text: 'Write tests' });
    });

    await waitFor(() => {
      expect(result.current.addItem.isSuccess).toBe(true);
    });

    expect(mockedAddChecklistItem).toHaveBeenCalledWith(workspaceId, objectId, 'Write tests');
  });

  it('optimistically appends a new item (with some temp id, done: false) to the cache before the server responds', async () => {
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedAddChecklistItem.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, []);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.addItem.mutate({ text: 'Write tests' });
    });

    await waitFor(() => {
      expect(result.current.addItem.isPending).toBe(true);
    });

    const checklist = readCachedChecklist(queryClient);
    expect(checklist).toHaveLength(1);
    expect(checklist[0]).toMatchObject({ text: 'Write tests', done: false, order: 0 });
    expect(typeof checklist[0]?.id).toBe('string');
    expect((checklist[0]?.id.length ?? 0) > 0).toBe(true);

    await act(async () => {
      resolve(makeObject([makeChecklistItem({ id: 'server-item-1' })]));
      await promise;
    });
  });

  it("replaces the optimistic temp item with the server's real item (real id) on success", async () => {
    const serverResult = makeObject([makeChecklistItem({ id: 'server-item-1' })]);
    mockedAddChecklistItem.mockResolvedValueOnce(serverResult);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, []);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.addItem.mutate({ text: 'Write tests' });
    });

    await waitFor(() => {
      expect(result.current.addItem.isSuccess).toBe(true);
    });

    const checklist = readCachedChecklist(queryClient);
    expect(checklist).toEqual([makeChecklistItem({ id: 'server-item-1' })]);
  });

  it('rolls back the optimistic add when addChecklistItem rejects', async () => {
    const error = new Error('network down');
    mockedAddChecklistItem.mockRejectedValueOnce(error);
    const { queryClient, Wrapper } = createWrapper();
    const original = seedCache(queryClient, []);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.addItem.mutate({ text: 'Write tests' });
    });

    await waitFor(() => {
      expect(result.current.addItem.isError).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(original);
  });
});

describe('useChecklistMutations — toggleItem', () => {
  it('calls apiClient.toggleChecklistItem with the workspace id, object id and itemId on mutate', async () => {
    const seeded = [makeChecklistItem({ id: 'item-1', done: false })];
    mockedToggleChecklistItem.mockResolvedValueOnce(
      makeObject([makeChecklistItem({ id: 'item-1', done: true })]),
    );
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, seeded);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.toggleItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.toggleItem.isSuccess).toBe(true);
    });

    expect(mockedToggleChecklistItem).toHaveBeenCalledWith(workspaceId, objectId, 'item-1');
  });

  it("optimistically flips the matching item's done before the server responds", async () => {
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedToggleChecklistItem.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, [makeChecklistItem({ id: 'item-1', done: false })]);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.toggleItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.toggleItem.isPending).toBe(true);
    });

    const checklist = readCachedChecklist(queryClient);
    expect(checklist.find((item) => item.id === 'item-1')?.done).toBe(true);

    await act(async () => {
      resolve(makeObject([makeChecklistItem({ id: 'item-1', done: true })]));
      await promise;
    });
  });

  it('rolls back the optimistic toggle when toggleChecklistItem rejects', async () => {
    const error = new Error('network down');
    mockedToggleChecklistItem.mockRejectedValueOnce(error);
    const { queryClient, Wrapper } = createWrapper();
    const original = seedCache(queryClient, [makeChecklistItem({ id: 'item-1', done: false })]);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.toggleItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.toggleItem.isError).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(original);
  });
});

describe('useChecklistMutations — removeItem', () => {
  it('calls apiClient.removeChecklistItem with the workspace id, object id and itemId on mutate', async () => {
    mockedRemoveChecklistItem.mockResolvedValueOnce(makeObject([]));
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, [makeChecklistItem({ id: 'item-1' })]);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.removeItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.removeItem.isSuccess).toBe(true);
    });

    expect(mockedRemoveChecklistItem).toHaveBeenCalledWith(workspaceId, objectId, 'item-1');
  });

  it('optimistically removes the matching item from the cache before the server responds', async () => {
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedRemoveChecklistItem.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, [
      makeChecklistItem({ id: 'item-1' }),
      makeChecklistItem({ id: 'item-2', order: 1 }),
    ]);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.removeItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.removeItem.isPending).toBe(true);
    });

    const checklist = readCachedChecklist(queryClient);
    expect(checklist.map((item) => item.id)).toEqual(['item-2']);

    await act(async () => {
      resolve(makeObject([makeChecklistItem({ id: 'item-2', order: 0 })]));
      await promise;
    });
  });

  it('rolls back the optimistic removal when removeChecklistItem rejects', async () => {
    const error = new Error('network down');
    mockedRemoveChecklistItem.mockRejectedValueOnce(error);
    const { queryClient, Wrapper } = createWrapper();
    const original = seedCache(queryClient, [makeChecklistItem({ id: 'item-1' })]);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.removeItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.removeItem.isError).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(original);
  });
});

describe('useChecklistMutations — cross-mutation rollback isolation (surgical, not whole-object, rollback)', () => {
  it("does not clobber a different mutation's already-succeeded, already-committed change when a later mutation's rollback fires (toggle succeeds first, then add fails)", async () => {
    const seeded = [makeChecklistItem({ id: 'item-1', done: false })];
    mockedToggleChecklistItem.mockResolvedValueOnce(
      makeObject([makeChecklistItem({ id: 'item-1', done: true })]),
    );
    const addError = new Error('network down');
    mockedAddChecklistItem.mockRejectedValueOnce(addError);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, seeded);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    // Mutation A: toggleItem — fires and fully succeeds first, committing
    // done: true to the cache via its real onSuccess.
    act(() => {
      result.current.toggleItem.mutate({ itemId: 'item-1' });
    });

    await waitFor(() => {
      expect(result.current.toggleItem.isSuccess).toBe(true);
    });

    expect(readCachedChecklist(queryClient).find((item) => item.id === 'item-1')?.done).toBe(true);

    // Mutation B: addItem — fires afterwards and rejects. Its rollback must
    // only undo its OWN optimistic add (the temp item it introduced), never
    // restore a stale whole-object snapshot that would clobber mutation A's
    // already-committed done: true.
    act(() => {
      result.current.addItem.mutate({ text: 'New task' });
    });

    await waitFor(() => {
      expect(result.current.addItem.isError).toBe(true);
    });

    const checklist = readCachedChecklist(queryClient);
    expect(checklist.some((item) => item.id.startsWith('temp-'))).toBe(false);
    expect(checklist.find((item) => item.id === 'item-1')?.done).toBe(true);
  });

  it("does not clobber a different mutation's already-succeeded, already-committed change when a later mutation's rollback fires (add succeeds first, then toggle fails)", async () => {
    mockedAddChecklistItem.mockResolvedValueOnce(
      makeObject([makeChecklistItem({ id: 'server-item-1', done: false })]),
    );
    const toggleError = new Error('network down');
    mockedToggleChecklistItem.mockRejectedValueOnce(toggleError);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, []);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    // Mutation A: addItem — fires and fully succeeds first, replacing the
    // optimistic temp item with the server's real item id in the cache.
    act(() => {
      result.current.addItem.mutate({ text: 'Write tests' });
    });

    await waitFor(() => {
      expect(result.current.addItem.isSuccess).toBe(true);
    });

    expect(readCachedChecklist(queryClient)).toEqual([
      makeChecklistItem({ id: 'server-item-1', done: false }),
    ]);

    // Mutation B: toggleItem — targets the now-real server item id, fires
    // afterwards, and rejects. Its rollback must restore only that item's
    // `done` field against the CURRENT cache, not overwrite the whole object
    // with a stale pre-add snapshot (which would silently delete mutation
    // A's already-committed real item).
    act(() => {
      result.current.toggleItem.mutate({ itemId: 'server-item-1' });
    });

    await waitFor(() => {
      expect(result.current.toggleItem.isError).toBe(true);
    });

    expect(readCachedChecklist(queryClient)).toEqual([
      makeChecklistItem({ id: 'server-item-1', done: false }),
    ]);
  });
});

describe('useChecklistMutations — reorderItems', () => {
  const seeded = [
    makeChecklistItem({ id: 'item-1', order: 0 }),
    makeChecklistItem({ id: 'item-2', order: 1 }),
    makeChecklistItem({ id: 'item-3', order: 2 }),
  ];

  it('calls apiClient.reorderChecklistItem with the workspace id, object id and orderedItemIds on mutate', async () => {
    mockedReorderChecklistItem.mockResolvedValueOnce(
      makeObject([
        makeChecklistItem({ id: 'item-2', order: 0 }),
        makeChecklistItem({ id: 'item-1', order: 1 }),
        makeChecklistItem({ id: 'item-3', order: 2 }),
      ]),
    );
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, seeded);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.reorderItems.mutate({ orderedItemIds: ['item-2', 'item-1', 'item-3'] });
    });

    await waitFor(() => {
      expect(result.current.reorderItems.isSuccess).toBe(true);
    });

    expect(mockedReorderChecklistItem).toHaveBeenCalledWith(workspaceId, objectId, [
      'item-2',
      'item-1',
      'item-3',
    ]);
  });

  it('optimistically resequences the cached checklist into the given orderedItemIds order before the server responds', async () => {
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedReorderChecklistItem.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, seeded);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.reorderItems.mutate({ orderedItemIds: ['item-2', 'item-1', 'item-3'] });
    });

    await waitFor(() => {
      expect(result.current.reorderItems.isPending).toBe(true);
    });

    const checklist = readCachedChecklist(queryClient);
    expect(checklist.map((item) => item.id)).toEqual(['item-2', 'item-1', 'item-3']);
    expect(checklist.map((item) => item.order)).toEqual([0, 1, 2]);

    await act(async () => {
      resolve(
        makeObject([
          makeChecklistItem({ id: 'item-2', order: 0 }),
          makeChecklistItem({ id: 'item-1', order: 1 }),
          makeChecklistItem({ id: 'item-3', order: 2 }),
        ]),
      );
      await promise;
    });
  });

  it('rolls back the optimistic reorder when reorderChecklistItem rejects', async () => {
    const error = new Error('network down');
    mockedReorderChecklistItem.mockRejectedValueOnce(error);
    const { queryClient, Wrapper } = createWrapper();
    const original = seedCache(queryClient, seeded);

    const { result } = renderHook(() => useChecklistMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.reorderItems.mutate({ orderedItemIds: ['item-2', 'item-1', 'item-3'] });
    });

    await waitFor(() => {
      expect(result.current.reorderItems.isError).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(original);
  });
});
