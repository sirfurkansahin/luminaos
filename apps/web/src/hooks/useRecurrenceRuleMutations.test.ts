import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecurrenceRule } from '@luminaos/core-objects';

import { useRecurrenceRuleMutations } from './useRecurrenceRuleMutations.js';
import { clearRecurrenceRule, setRecurrenceRule } from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useRecurrenceRuleMutations.ts to satisfy these tests.
 * That's the expected TDD red state — this file fails to even resolve its
 * own `./useRecurrenceRuleMutations.js` import until the hook exists. It
 * also imports two apiClient.ts exports (`setRecurrenceRule`,
 * `clearRecurrenceRule`) that do not exist there yet either — mocked
 * wholesale below via `vi.mock`, mirroring useChecklistMutations.test.ts's
 * own apiClient mocking style — but until apiClient.ts actually exports
 * them, this file also fails TypeScript resolution/typecheck. Both gaps are
 * `implementer`'s job, not test-writer's.
 *
 *   export function setRecurrenceRule(
 *     workspaceId: string, objectId: string, rule: RecurrenceRule,
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *     // POST /workspaces/:workspaceId/objects/:objectId/recurrence-rule, body = rule
 *   export function clearRecurrenceRule(
 *     workspaceId: string, objectId: string,
 *   ): Promise<{ object: ObjectWithFieldValues }>;
 *     // DELETE /workspaces/:workspaceId/objects/:objectId/recurrence-rule
 *
 *   export interface RecurrenceRuleMutations {
 *     setRule: UseMutationResult<{ object: ObjectWithFieldValues }, Error, RecurrenceRule, SetRuleContext>;
 *     clearRule: UseMutationResult<{ object: ObjectWithFieldValues }, Error, void, ClearRuleContext>;
 *   }
 *   export function useRecurrenceRuleMutations(workspaceId: string, objectId: string): RecurrenceRuleMutations;
 *
 * DESIGN DECISION — own dedicated mutation hook (NOT the shared
 * `useSetFieldValuesMutation`), mirroring `useChecklistMutations`'s own
 * design decision exactly, for the same reason: `setRecurrenceRule`/
 * `clearRecurrenceRule` are their own dedicated HTTP routes (PR6b), not the
 * shared custom-fields PATCH route, and both mutate the SAME single cache
 * entry `['object', workspaceId, objectId]` (the same key `useObjectQuery`
 * reads) that `TaskDetailPanel` already renders from — so this hook, like
 * `useChecklistMutations`, operates DIRECTLY against that cache entry rather
 * than the flat `['objects', workspaceId]` list `useSetFieldValuesMutation`
 * targets.
 *
 * SURGICAL ROLLBACK DISCIPLINE (carried over from useChecklistMutations's
 * own ALREADY-FIXED bug, see that file's top-of-file comment): each
 * mutation's rollback context remembers ONLY the single `recurrenceRule`
 * value this specific mutation's own optimistic write changed
 * (`context.previousRecurrenceRule`), never a whole-object cache snapshot.
 * `onError` reads the CURRENT cache state (which may have been changed by a
 * different, unrelated, already-succeeded mutation — e.g. a title rename or
 * a StatusPrioritySelect edit — since this mutation's own `onMutate` ran)
 * and writes back only the `recurrenceRule` key against it, leaving every
 * other field (title, fieldValues, checklist, ...) exactly as the current
 * cache holds it. A whole-object snapshot restored unconditionally on error
 * would silently clobber that other, unrelated, already-committed change —
 * this is the exact bug class useChecklistMutations's rollback was fixed to
 * avoid, and this hook must not reintroduce it for its own field.
 *
 *   - setRule: `mutate(rule)` where `rule` is the full `RecurrenceRule`
 *     shape (`{ frequency, interval, byWeekday?, endDate? }`) the caller
 *     built. `onMutate` captures `context.previousRecurrenceRule =
 *     <current cache's object.recurrenceRule>`, then optimistically writes
 *     `object.recurrenceRule = rule` (the mutate variables themselves,
 *     verbatim) to the cache. `onError` writes `object.recurrenceRule =
 *     context.previousRecurrenceRule` against the CURRENT cache (not a
 *     stale snapshot). `onSuccess` replaces the whole cache entry with the
 *     mutationFn's own resolved `{ object }` (the server's real, settled
 *     state).
 *   - clearRule: `mutate()` (no variables — `TVariables` is `void`).
 *     `onMutate` captures `context.previousRecurrenceRule` the same way,
 *     then optimistically writes `object.recurrenceRule = undefined`.
 *     `onError`/`onSuccess` mirror setRule's.
 */

vi.mock('../lib/apiClient.js', () => ({
  setRecurrenceRule: vi.fn(),
  clearRecurrenceRule: vi.fn(),
}));

const mockedSetRecurrenceRule = vi.mocked(setRecurrenceRule);
const mockedClearRecurrenceRule = vi.mocked(clearRecurrenceRule);

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

function makeObject(overrides: { title?: string; recurrenceRule?: RecurrenceRule } = {}): {
  object: ObjectWithFieldValues;
} {
  const { title = 'Ship PR6g', recurrenceRule } = overrides;
  return {
    object: {
      id: objectId,
      type: 'task',
      workspaceId,
      title,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      lifecycle: 'active',
      checklist: [],
      fieldValues: {},
      ...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
    } as unknown as ObjectWithFieldValues,
  };
}

function seedCache(
  queryClient: QueryClient,
  overrides: { title?: string; recurrenceRule?: RecurrenceRule } = {},
): { object: ObjectWithFieldValues } {
  const payload = makeObject(overrides);
  queryClient.setQueryData(queryKey, payload);
  return payload;
}

function readCachedRecurrenceRule(queryClient: QueryClient): RecurrenceRule | undefined {
  const cached = queryClient.getQueryData<{ object: ObjectWithFieldValues }>(queryKey);
  return cached?.object.recurrenceRule;
}

function readCachedTitle(queryClient: QueryClient): string | undefined {
  const cached = queryClient.getQueryData<{ object: ObjectWithFieldValues }>(queryKey);
  return cached?.object.title;
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

describe('useRecurrenceRuleMutations — setRule', () => {
  it('calls apiClient.setRecurrenceRule with the workspace id, object id and rule input on mutate', async () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 2 };
    mockedSetRecurrenceRule.mockResolvedValueOnce(makeObject({ recurrenceRule: rule }));
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient);

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setRule.mutate(rule);
    });

    await waitFor(() => {
      expect(result.current.setRule.isSuccess).toBe(true);
    });

    expect(mockedSetRecurrenceRule).toHaveBeenCalledWith(workspaceId, objectId, rule);
  });

  it('optimistically sets recurrenceRule on the cached object before the server responds', async () => {
    const rule: RecurrenceRule = { frequency: 'weekly', interval: 1, byWeekday: [1, 3] };
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedSetRecurrenceRule.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient);

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setRule.mutate(rule);
    });

    await waitFor(() => {
      expect(result.current.setRule.isPending).toBe(true);
    });

    expect(readCachedRecurrenceRule(queryClient)).toEqual(rule);

    await act(async () => {
      resolve(makeObject({ recurrenceRule: rule }));
      await promise;
    });
  });

  it("replaces the cached object with the server's resolved object on success", async () => {
    const submittedRule: RecurrenceRule = { frequency: 'monthly', interval: 1 };
    const serverResult = makeObject({ recurrenceRule: { frequency: 'monthly', interval: 1 } });
    mockedSetRecurrenceRule.mockResolvedValueOnce(serverResult);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient);

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setRule.mutate(submittedRule);
    });

    await waitFor(() => {
      expect(result.current.setRule.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(serverResult);
  });

  it('rolls back recurrenceRule to its previous value (and only that field) when setRecurrenceRule rejects', async () => {
    const error = new Error('network down');
    mockedSetRecurrenceRule.mockRejectedValueOnce(error);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { title: 'Original Title' });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setRule.mutate({ frequency: 'daily', interval: 3 });
    });

    await waitFor(() => {
      expect(result.current.setRule.isError).toBe(true);
    });

    expect(readCachedRecurrenceRule(queryClient)).toBeUndefined();
    expect(readCachedTitle(queryClient)).toBe('Original Title');
  });
});

describe('useRecurrenceRuleMutations — clearRule', () => {
  const existingRule: RecurrenceRule = { frequency: 'weekly', interval: 1, byWeekday: [0, 2, 4] };

  it('calls apiClient.clearRecurrenceRule with the workspace id and object id on mutate()', async () => {
    mockedClearRecurrenceRule.mockResolvedValueOnce(makeObject());
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { recurrenceRule: existingRule });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.clearRule.mutate();
    });

    await waitFor(() => {
      expect(result.current.clearRule.isSuccess).toBe(true);
    });

    expect(mockedClearRecurrenceRule).toHaveBeenCalledWith(workspaceId, objectId);
  });

  it('optimistically sets recurrenceRule to undefined before the server responds', async () => {
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedClearRecurrenceRule.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { recurrenceRule: existingRule });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.clearRule.mutate();
    });

    await waitFor(() => {
      expect(result.current.clearRule.isPending).toBe(true);
    });

    expect(readCachedRecurrenceRule(queryClient)).toBeUndefined();

    await act(async () => {
      resolve(makeObject());
      await promise;
    });
  });

  it("replaces the cached object with the server's resolved object on success", async () => {
    const serverResult = makeObject();
    mockedClearRecurrenceRule.mockResolvedValueOnce(serverResult);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { recurrenceRule: existingRule });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.clearRule.mutate();
    });

    await waitFor(() => {
      expect(result.current.clearRule.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(serverResult);
  });

  it('rolls back recurrenceRule to its previous value when clearRecurrenceRule rejects', async () => {
    const error = new Error('network down');
    mockedClearRecurrenceRule.mockRejectedValueOnce(error);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { recurrenceRule: existingRule });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.clearRule.mutate();
    });

    await waitFor(() => {
      expect(result.current.clearRule.isError).toBe(true);
    });

    expect(readCachedRecurrenceRule(queryClient)).toEqual(existingRule);
  });
});

describe('useRecurrenceRuleMutations — surgical (not whole-object) rollback discipline', () => {
  it("does not clobber an unrelated field (title) change that landed after this mutation's own onMutate, when setRule's rollback fires", async () => {
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedSetRecurrenceRule.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { title: 'Original Title' });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setRule.mutate({ frequency: 'daily', interval: 2 });
    });

    await waitFor(() => {
      expect(result.current.setRule.isPending).toBe(true);
    });

    // Simulate an unrelated mutation (e.g. a title rename) committing its
    // own successful result to the SAME cache entry while setRule is still
    // in flight — this is exactly the scenario a whole-object snapshot
    // rollback would clobber.
    queryClient.setQueryData<{ object: ObjectWithFieldValues }>(queryKey, (old) =>
      old === undefined ? old : { ...old, object: { ...old.object, title: 'Updated Title' } },
    );

    await act(async () => {
      resolve(Promise.reject(new Error('network down')) as never);
      await promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.setRule.isError).toBe(true);
    });

    expect(readCachedTitle(queryClient)).toBe('Updated Title');
    expect(readCachedRecurrenceRule(queryClient)).toBeUndefined();
  });

  it("does not clobber an unrelated field (title) change that landed after this mutation's own onMutate, when clearRule's rollback fires", async () => {
    const existingRule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const { promise, resolve } = pendingPromise<{ object: ObjectWithFieldValues }>();
    mockedClearRecurrenceRule.mockReturnValueOnce(promise);
    const { queryClient, Wrapper } = createWrapper();
    seedCache(queryClient, { title: 'Original Title', recurrenceRule: existingRule });

    const { result } = renderHook(() => useRecurrenceRuleMutations(workspaceId, objectId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.clearRule.mutate();
    });

    await waitFor(() => {
      expect(result.current.clearRule.isPending).toBe(true);
    });

    queryClient.setQueryData<{ object: ObjectWithFieldValues }>(queryKey, (old) =>
      old === undefined ? old : { ...old, object: { ...old.object, title: 'Updated Title' } },
    );

    await act(async () => {
      resolve(Promise.reject(new Error('network down')) as never);
      await promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.clearRule.isError).toBe(true);
    });

    expect(readCachedTitle(queryClient)).toBe('Updated Title');
    expect(readCachedRecurrenceRule(queryClient)).toEqual(existingRule);
  });
});
