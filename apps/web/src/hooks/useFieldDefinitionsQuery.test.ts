import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinition } from '@luminaos/core-objects';

import { useFieldDefinitionsQuery } from './useFieldDefinitionsQuery.js';
import { getFieldDefinitions } from '../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useFieldDefinitionsQuery.ts to satisfy these tests.
 * That's the expected TDD red state — this file fails to even resolve its
 * own `./useFieldDefinitionsQuery.js` import until the hook exists.):
 *
 *   export function useFieldDefinitionsQuery(
 *     workspaceId: string,
 *     objectType: string | undefined,
 *   ): UseQueryResult<{ fieldDefinitions: FieldDefinition[] }>;
 *       // thin wrapper around useQuery — queryFn delegates to
 *       // apiClient.ts's getFieldDefinitions(workspaceId, objectType as
 *       // string). queryKey MUST be (or start with) ['fieldDefinitions',
 *       // workspaceId, objectType], mirroring useSavedViewsQuery.ts's
 *       // ['savedViews', workspaceId, objectType] convention.
 *       // `objectType` is `| undefined` (not required, unlike
 *       // useSavedViewsQuery's) and the query is `enabled: objectType !==
 *       // undefined` — mirroring apps/web/src/hooks/useObjectsQuery.ts's
 *       // `useObjectQuery(workspaceId, objectId: string | undefined)`
 *       // pattern exactly. This is needed because TaskDetailPanel (this
 *       // hook's sole consumer) must call it unconditionally on every
 *       // render (rules of hooks), but the object's type is not known until
 *       // useObjectQuery's own fetch resolves — before that, TaskDetailPanel
 *       // passes `undefined`. This is a single-shot lookup (fetch once per
 *       // objectType, pass individual FieldDefinition entries down to each
 *       // StatusPrioritySelect instance) — scope kept minimal here,
 *       // mirroring useSavedViewsQuery.test.ts's `useSavedViewsQuery`
 *       // describe block (success + error), not its mutation hooks (this
 *       // hook has no mutation counterpart), plus one extra case for the
 *       // `enabled: false` (objectType undefined) branch that
 *       // useSavedViewsQuery.ts has no equivalent of.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * is pinned separately by apps/web/src/lib/apiClient.test.ts, not here.
 */

vi.mock('../lib/apiClient.js', () => ({
  getFieldDefinitions: vi.fn(),
}));

const mockedGetFieldDefinitions = vi.mocked(getFieldDefinitions);

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

function makeFieldDefinitionFixture(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'field-status',
    workspaceId: 'ws-1',
    objectType: 'task',
    key: 'status',
    label: 'Durum',
    fieldType: 'select',
    config: {
      options: [
        { value: 'todo', label: 'Yapılacak' },
        { value: 'done', label: 'Tamamlandı', isDone: true },
      ],
    },
    permissions: { owner: 'edit', admin: 'edit', member: 'edit', guest: 'view' },
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFieldDefinitionsQuery', () => {
  const workspaceId = 'ws-1';
  const objectType = 'task';

  it('calls apiClient.getFieldDefinitions with the workspace id and object type', async () => {
    const fieldDefinition = makeFieldDefinitionFixture();
    mockedGetFieldDefinitions.mockResolvedValueOnce({ fieldDefinitions: [fieldDefinition] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFieldDefinitionsQuery(workspaceId, objectType), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGetFieldDefinitions).toHaveBeenCalledWith(workspaceId, objectType);
    expect(result.current.data).toEqual({ fieldDefinitions: [fieldDefinition] });
  });

  it('transitions to isError with the thrown error when apiClient.getFieldDefinitions rejects', async () => {
    const error = new Error('boom');
    mockedGetFieldDefinitions.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFieldDefinitionsQuery(workspaceId, objectType), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });

  it('does not call apiClient.getFieldDefinitions and stays disabled when objectType is undefined', async () => {
    const { result } = renderHook(() => useFieldDefinitionsQuery(workspaceId, undefined), {
      wrapper: createWrapper().Wrapper,
    });

    // Give any accidental fetch a chance to fire before asserting it didn't.
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    expect(mockedGetFieldDefinitions).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });
});
