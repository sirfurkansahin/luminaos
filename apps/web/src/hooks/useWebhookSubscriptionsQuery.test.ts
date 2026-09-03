import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useCreateWebhookSubscriptionMutation,
  useDeleteWebhookSubscriptionMutation,
  useWebhookSubscriptionsQuery,
} from './useWebhookSubscriptionsQuery.js';
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
} from '../lib/apiClient.js';

import type { CreatedWebhookSubscription, WebhookSubscription } from '../lib/apiClient.js';

/**
 * F2-T16 PR4 (ADR-0033 §g, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/hooks/useWebhookSubscriptionsQuery.ts AND add the following
 * new exports to apps/web/src/lib/apiClient.ts to satisfy these tests; that's
 * the expected TDD red state), mirroring useMcpGrantsQuery.ts/.test.ts's
 * exact query-key/invalidation shape and test structure:
 *
 *   // apps/web/src/lib/apiClient.ts
 *   export interface WebhookSubscription {
 *     id: string; targetUrl: string; eventTypes: string[]; createdAt: string;
 *   }
 *   export interface CreatedWebhookSubscription extends WebhookSubscription {
 *     signingSecret: string; // present ONLY on create, never on list
 *   }
 *   export function listWebhookSubscriptions(
 *     workspaceId: string,
 *   ): Promise<{ subscriptions: WebhookSubscription[] }>;
 *   export function createWebhookSubscription(
 *     workspaceId: string, input: { targetUrl: string; eventTypes: string[] },
 *   ): Promise<{ subscription: CreatedWebhookSubscription }>;
 *   export function deleteWebhookSubscription(
 *     workspaceId: string, subscriptionId: string,
 *   ): Promise<void>;
 *
 *   // apps/web/src/hooks/useWebhookSubscriptionsQuery.ts
 *   export function useWebhookSubscriptionsQuery(workspaceId: string):
 *     UseQueryResult<{ subscriptions: WebhookSubscription[] }>;
 *       // queryKey MUST be (or start with) ['webhook-subscriptions', workspaceId]
 *   export function useCreateWebhookSubscriptionMutation(workspaceId: string):
 *     UseMutationResult<
 *       { subscription: CreatedWebhookSubscription }, Error,
 *       { targetUrl: string; eventTypes: string[] }
 *     >;
 *       // mutationFn delegates to createWebhookSubscription(workspaceId, variables).
 *       // onSuccess invalidates ['webhook-subscriptions', workspaceId] queries.
 *   export function useDeleteWebhookSubscriptionMutation(workspaceId: string):
 *     UseMutationResult<void, Error, string>; // variables = subscriptionId
 *       // mutationFn delegates to deleteWebhookSubscription(workspaceId, subscriptionId).
 *       // onSuccess invalidates ['webhook-subscriptions', workspaceId] queries.
 *
 * apiClient.ts itself is mocked wholesale below (vi.mock) — its own contract
 * for the three new functions above is pinned only by this file, per
 * apiClient.ts's existing convention of being exercised only through its
 * consumers' tests (see useMcpGrantsQuery.test.ts's identical rationale).
 */

vi.mock('../lib/apiClient.js', () => ({
  listWebhookSubscriptions: vi.fn(),
  createWebhookSubscription: vi.fn(),
  deleteWebhookSubscription: vi.fn(),
}));

const mockedListWebhookSubscriptions = vi.mocked(listWebhookSubscriptions);
const mockedCreateWebhookSubscription = vi.mocked(createWebhookSubscription);
const mockedDeleteWebhookSubscription = vi.mocked(deleteWebhookSubscription);

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

function makeSubscriptionFixture(
  overrides: Partial<WebhookSubscription> = {},
): WebhookSubscription {
  return {
    id: 'sub-1',
    targetUrl: 'https://example.com/hooks/lumina',
    eventTypes: ['ActionsProposed'],
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCreatedSubscriptionFixture(
  overrides: Partial<CreatedWebhookSubscription> = {},
): CreatedWebhookSubscription {
  return {
    ...makeSubscriptionFixture(),
    signingSecret: 'whsec_FIXTURE_SIGNING_SECRET_VALUE_ONLY_SHOWN_ONCE',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useWebhookSubscriptionsQuery', () => {
  const workspaceId = 'ws-1';

  it('calls apiClient.listWebhookSubscriptions with the workspace id', async () => {
    const subscription = makeSubscriptionFixture();
    mockedListWebhookSubscriptions.mockResolvedValueOnce({ subscriptions: [subscription] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWebhookSubscriptionsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedListWebhookSubscriptions).toHaveBeenCalledWith(workspaceId);
    expect(result.current.data).toEqual({ subscriptions: [subscription] });
  });

  it('transitions to isError with the thrown error when apiClient.listWebhookSubscriptions rejects', async () => {
    const error = new Error('boom');
    mockedListWebhookSubscriptions.mockRejectedValueOnce(error);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWebhookSubscriptionsQuery(workspaceId), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(error);
  });
});

describe('useCreateWebhookSubscriptionMutation', () => {
  const workspaceId = 'ws-1';
  const variables = {
    targetUrl: 'https://example.com/hooks/lumina',
    eventTypes: ['ActionsProposed'],
  };

  it('calls apiClient.createWebhookSubscription with the workspace id and variables on mutate', async () => {
    mockedCreateWebhookSubscription.mockResolvedValueOnce({
      subscription: makeCreatedSubscriptionFixture(),
    });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateWebhookSubscriptionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedCreateWebhookSubscription).toHaveBeenCalledWith(workspaceId, variables);
  });

  it('invalidates cached ["webhook-subscriptions", workspaceId] queries once the mutation succeeds', async () => {
    mockedCreateWebhookSubscription.mockResolvedValueOnce({
      subscription: makeCreatedSubscriptionFixture(),
    });
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateWebhookSubscriptionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('webhook-subscriptions');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });

  it('resolves with the { subscription } shape returned by apiClient.createWebhookSubscription, including the one-time signingSecret', async () => {
    const createResult = { subscription: makeCreatedSubscriptionFixture() };
    mockedCreateWebhookSubscription.mockResolvedValueOnce(createResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateWebhookSubscriptionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(variables);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(createResult);
    expect(result.current.data?.subscription.signingSecret).toEqual(
      createResult.subscription.signingSecret,
    );
  });
});

describe('useDeleteWebhookSubscriptionMutation', () => {
  const workspaceId = 'ws-1';
  const subscriptionId = 'sub-1';

  it('calls apiClient.deleteWebhookSubscription with the workspace id and subscription id on mutate', async () => {
    mockedDeleteWebhookSubscription.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteWebhookSubscriptionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(subscriptionId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockedDeleteWebhookSubscription).toHaveBeenCalledWith(workspaceId, subscriptionId);
  });

  it('invalidates cached ["webhook-subscriptions", workspaceId] queries once the mutation succeeds', async () => {
    mockedDeleteWebhookSubscription.mockResolvedValueOnce(undefined);
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteWebhookSubscriptionMutation(workspaceId), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.mutate(subscriptionId);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('webhook-subscriptions');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });
});
