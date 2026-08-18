import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemoryRecord } from '@luminaos/memory';

import {
  useCreateMemoryRecordMutation,
  useDeleteMemoryRecordMutation,
  useMemoryRecordsQuery,
  useUpdateMemoryRecordMutation,
} from './useMemoryRecordsQuery.js';
import {
  createMemoryRecord,
  deleteMemoryRecord,
  getMemoryRecords,
  updateMemoryRecord,
} from '../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useMemoryRecordsQuery.ts to satisfy these tests. That's
 * the expected TDD red state.):
 *
 *   export function useMemoryRecordsQuery(
 *     workspaceId: string,
 *   ): UseQueryResult<{ records: MemoryRecord[] }>;
 *       // thin wrapper around useQuery — queryFn delegates to
 *       // apiClient.ts's getMemoryRecords(workspaceId). queryKey MUST be
 *       // (or start with) ['memoryRecords', workspaceId] so the mutation
 *       // hooks below can invalidate it by key prefix.
 *
 *   export function useCreateMemoryRecordMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<{ record: MemoryRecord }, Error, { content: string }>;
 *       // mutationFn delegates to apiClient.ts's
 *       // createMemoryRecord(workspaceId, input). onSuccess invalidates
 *       // ['memoryRecords', workspaceId] queries.
 *
 *   export function useUpdateMemoryRecordMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<
 *     { record: MemoryRecord },
 *     Error,
 *     { recordId: string; input: { content: string } }
 *   >;
 *       // mutationFn delegates to apiClient.ts's
 *       // updateMemoryRecord(workspaceId, variables.recordId, variables.input).
 *       // onSuccess invalidates ['memoryRecords', workspaceId] queries.
 *
 *   export function useDeleteMemoryRecordMutation(
 *     workspaceId: string,
 *   ): UseMutationResult<void, Error, string>; // variables = recordId
 *       // mutationFn delegates to apiClient.ts's
 *       // deleteMemoryRecord(workspaceId, recordId). onSuccess invalidates
 *       // ['memoryRecords', workspaceId] queries.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * is pinned separately by apps/web/src/lib/apiClient.test.ts, not here.
 */

vi.mock('../lib/apiClient.js', () => ({
  getMemoryRecords: vi.fn(),
  createMemoryRecord: vi.fn(),
  updateMemoryRecord: vi.fn(),
  deleteMemoryRecord: vi.fn(),
}));

const mockedGetMemoryRecords = vi.mocked(getMemoryRecords);
const mockedCreateMemoryRecord = vi.mocked(createMemoryRecord);
const mockedUpdateMemoryRecord = vi.mocked(updateMemoryRecord);
const mockedDeleteMemoryRecord = vi.mocked(deleteMemoryRecord);

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

function makeMemoryRecordFixture(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    content: 'Kahve yerine çay tercih ederim.',
    kaynakOlayId: 'evt-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMemoryRecordsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.getMemoryRecords with the workspace id', async () => {
    const record = makeMemoryRecordFixture();
    mockedGetMemoryRecords.mockResolvedValueOnce({ records: [record] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useMemoryRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedGetMemoryRecords).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ records: [record] });
  });

  it('transitions to isError with the thrown error when apiClient.getMemoryRecords rejects', async () => {
    const error = new Error('boom');
    mockedGetMemoryRecords.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useMemoryRecordsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useCreateMemoryRecordMutation', () => {
  const workspaceId = 'ws-1';
  const input = { content: 'Kahve yerine çay tercih ederim.' };

  it('calls apiClient.createMemoryRecord with the workspace id and input on mutate', async () => {
    mockedCreateMemoryRecord.mockResolvedValueOnce({ record: makeMemoryRecordFixture(input) });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateMemoryRecordMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCreateMemoryRecord).toHaveBeenCalledWith(workspaceId, input);
  });

  it('invalidates cached ["memoryRecords", workspaceId] queries once the mutation succeeds', async () => {
    mockedCreateMemoryRecord.mockResolvedValueOnce({ record: makeMemoryRecordFixture(input) });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateMemoryRecordMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('memoryRecords');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});

describe('useUpdateMemoryRecordMutation', () => {
  const workspaceId = 'ws-1';
  const recordId = 'mem-1';
  const input = { content: 'Güncellenmiş içerik.' };

  it('calls apiClient.updateMemoryRecord with the workspace id, record id and input on mutate', async () => {
    mockedUpdateMemoryRecord.mockResolvedValueOnce({
      record: makeMemoryRecordFixture({ id: recordId, ...input }),
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateMemoryRecordMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ recordId, input });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedUpdateMemoryRecord).toHaveBeenCalledWith(workspaceId, recordId, input);
  });

  it('invalidates cached ["memoryRecords", workspaceId] queries once the mutation succeeds', async () => {
    mockedUpdateMemoryRecord.mockResolvedValueOnce({
      record: makeMemoryRecordFixture({ id: recordId, ...input }),
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateMemoryRecordMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate({ recordId, input });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('memoryRecords');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});

describe('useDeleteMemoryRecordMutation', () => {
  const workspaceId = 'ws-1';
  const recordId = 'mem-1';

  it('calls apiClient.deleteMemoryRecord with the workspace id and record id on mutate', async () => {
    mockedDeleteMemoryRecord.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteMemoryRecordMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(recordId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedDeleteMemoryRecord).toHaveBeenCalledWith(workspaceId, recordId);
  });

  it('invalidates cached ["memoryRecords", workspaceId] queries once the mutation succeeds', async () => {
    mockedDeleteMemoryRecord.mockResolvedValueOnce(undefined);
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteMemoryRecordMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(recordId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('memoryRecords');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});
