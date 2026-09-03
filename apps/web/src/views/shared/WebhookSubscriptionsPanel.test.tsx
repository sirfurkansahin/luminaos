import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebhookSubscriptionsPanel as WebhookSubscriptionsPanelModuleExport } from './WebhookSubscriptionsPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T16 PR4 (ADR-0033 §g, spec Kabul Kriterleri: "Kullanıcı yeniden
 * kullanılabilir webhook aboneliklerini panelden oluşturabilir/silebilir") —
 * TDD red step. Contract under test (not yet implemented — implementer must
 * build apps/web/src/views/shared/WebhookSubscriptionsPanel.tsx to satisfy
 * these tests):
 *
 *   export interface WebhookSubscriptionsPanelProps { workspaceId: string; }
 *   export function WebhookSubscriptionsPanel(props: WebhookSubscriptionsPanelProps): React.JSX.Element;
 *
 * Mirrors `McpAccessPanel.tsx`/`McpAccessPanel.test.tsx` near-verbatim:
 * - list rendered DIRECTLY (not gated behind a dialog), four-state shape:
 *   isLoading -> data-testid="webhook-subscriptions-loading"; isError ->
 *   data-testid="webhook-subscriptions-error"; data.subscriptions.length === 0
 *   -> data-testid="webhook-subscriptions-empty"; otherwise -> one row per
 *   subscription, data-testid=`webhook-subscription-item-${id}` showing
 *   `targetUrl` and each of `eventTypes`.
 * - each row has a delete button (data-testid=`webhook-subscription-delete-
 *   ${id}`) that calls the delete mutation's `mutate` directly with that
 *   subscription's id -- NO confirmation dialog (mirrors McpAccessPanel's
 *   direct-revoke-no-confirm pattern).
 * - a visible trigger (data-testid="webhook-access-create-trigger") opens a
 *   create Dialog (data-testid="webhook-subscription-dialog"), closed by
 *   default/not in the DOM when closed.
 * - inside the dialog: a URL input (data-testid=
 *   "webhook-subscription-url-input"); two checkboxes for the two allowed
 *   event types (data-testid="webhook-subscription-eventtype-ActionsProposed"
 *   / "webhook-subscription-eventtype-ActionsDecided"), both unchecked by
 *   default; a submit button (data-testid="webhook-subscription-create-
 *   submit") that calls the create mutation's `mutate` with
 *   `{ targetUrl, eventTypes }` ONLY when the URL is non-empty AND at least
 *   one event type is checked.
 * - on successful creation (inline `onSuccess` callback, same
 *   `options?.onSuccess?.(...)` test-invocation pattern via `act()` as
 *   McpAccessPanel), the dialog switches to a reveal state
 *   (data-testid="webhook-subscription-reveal") containing the signingSecret
 *   (data-testid="webhook-subscription-secret") and a one-time warning
 *   (data-testid="webhook-subscription-reveal-warning"), plus a close button
 *   (data-testid="webhook-subscription-reveal-close") returning to the list
 *   view. The secret must never appear anywhere outside the reveal state.
 *
 * `useWebhookSubscriptionsQuery`/`useCreateWebhookSubscriptionMutation`/
 * `useDeleteWebhookSubscriptionMutation`
 * (../../hooks/useWebhookSubscriptionsQuery.ts) do not exist yet, so --
 * mirroring McpAccessPanel.test.tsx's handling of the equally-not-yet-
 * existing useMcpGrantsQuery hooks -- mock functions are created via
 * `vi.hoisted` and referenced ONLY by closure inside the `vi.mock` factory
 * below; this file never imports that hook module itself. The
 * `WebhookSubscription`/`CreatedWebhookSubscription` shapes are declared
 * locally for the same reason. `./WebhookSubscriptionsPanel.tsx` itself DOES
 * NOT exist yet either -- imported directly (`ModuleExport` cast, mirroring
 * McpAccessPanel.test.tsx's identical technique), so this test file is
 * expected to fail to even resolve that import until the component exists --
 * the documented TDD red state.
 */

interface WebhookSubscription {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  createdAt: string;
}

interface CreatedWebhookSubscription extends WebhookSubscription {
  signingSecret: string;
}

const {
  mockedUseWebhookSubscriptionsQuery,
  mockedUseCreateWebhookSubscriptionMutation,
  mockedUseDeleteWebhookSubscriptionMutation,
} = vi.hoisted(() => {
  return {
    mockedUseWebhookSubscriptionsQuery: vi.fn(),
    mockedUseCreateWebhookSubscriptionMutation: vi.fn(),
    mockedUseDeleteWebhookSubscriptionMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useWebhookSubscriptionsQuery.js', () => ({
  useWebhookSubscriptionsQuery: mockedUseWebhookSubscriptionsQuery,
  useCreateWebhookSubscriptionMutation: mockedUseCreateWebhookSubscriptionMutation,
  useDeleteWebhookSubscriptionMutation: mockedUseDeleteWebhookSubscriptionMutation,
}));

const WebhookSubscriptionsPanel = WebhookSubscriptionsPanelModuleExport;

const workspaceId = 'ws-1';

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

function mockQuery(
  data: { subscriptions: WebhookSubscription[] } | undefined,
  overrides: Partial<UseQueryResult<{ subscriptions: WebhookSubscription[] }>> = {},
): void {
  mockedUseWebhookSubscriptionsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function makeMutationResultBase(mutate: (...args: never[]) => void): Record<string, unknown> {
  return {
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  };
}

function mockMutations(): {
  createMutate: ReturnType<typeof vi.fn>;
  deleteMutate: ReturnType<typeof vi.fn>;
} {
  const createMutate = vi.fn();
  const deleteMutate = vi.fn();

  mockedUseCreateWebhookSubscriptionMutation.mockReturnValue(makeMutationResultBase(createMutate));
  mockedUseDeleteWebhookSubscriptionMutation.mockReturnValue(makeMutationResultBase(deleteMutate));

  return { createMutate, deleteMutate };
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('webhook-access-create-trigger'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WebhookSubscriptionsPanel', () => {
  it('renders a loading state (data-testid="webhook-subscriptions-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockMutations();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('webhook-subscriptions-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="webhook-subscriptions-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockMutations();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('webhook-subscriptions-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="webhook-subscriptions-empty") when there are zero subscriptions', () => {
    mockQuery({ subscriptions: [] });
    mockMutations();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('webhook-subscriptions-empty')).toBeInTheDocument();
  });

  it('renders one row per subscription, showing its targetUrl and eventTypes', () => {
    const subscription = makeSubscriptionFixture({
      id: 'sub-1',
      targetUrl: 'https://example.com/hooks/lumina',
      eventTypes: ['ActionsProposed', 'ActionsDecided'],
    });
    mockQuery({ subscriptions: [subscription] });
    mockMutations();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('webhook-subscription-item-sub-1');
    expect(row).toHaveTextContent('https://example.com/hooks/lumina');
    expect(row).toHaveTextContent('ActionsProposed');
    expect(row).toHaveTextContent('ActionsDecided');
  });

  it("clicking a row's delete button calls the delete mutation's mutate with that subscription's id", async () => {
    const subscription = makeSubscriptionFixture({ id: 'sub-1' });
    mockQuery({ subscriptions: [subscription] });
    const { deleteMutate } = mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('webhook-subscription-delete-sub-1'));

    expect(deleteMutate).toHaveBeenCalledWith('sub-1');
  });

  it('the list view never renders anything matching a long-opaque-secret-shaped string (list-shaped data has no signingSecret field)', () => {
    const subscription = makeSubscriptionFixture({ id: 'sub-1' });
    mockQuery({ subscriptions: [subscription] });
    mockMutations();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);

    expect(document.body.textContent).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });

  it('does not render the create dialog by default (closed)', () => {
    mockQuery({ subscriptions: [] });
    mockMutations();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);

    expect(screen.queryByTestId('webhook-subscription-dialog')).not.toBeInTheDocument();
  });

  it('opens the create dialog when the create trigger is clicked', async () => {
    mockQuery({ subscriptions: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    expect(screen.getByTestId('webhook-subscription-dialog')).toBeInTheDocument();
  });

  it('renders both event-type checkboxes unchecked by default', async () => {
    mockQuery({ subscriptions: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    expect(screen.getByTestId('webhook-subscription-eventtype-ActionsProposed')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByTestId('webhook-subscription-eventtype-ActionsDecided')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('does not call the create mutation when submitting with a URL but zero event types checked', async () => {
    mockQuery({ subscriptions: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(
      screen.getByTestId('webhook-subscription-url-input'),
      'https://example.com/hooks/lumina',
    );
    await user.click(screen.getByTestId('webhook-subscription-create-submit'));

    expect(createMutate).not.toHaveBeenCalled();
  });

  it('does not call the create mutation when submitting with an empty URL, even if an event type is checked', async () => {
    mockQuery({ subscriptions: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.click(screen.getByTestId('webhook-subscription-eventtype-ActionsProposed'));
    await user.click(screen.getByTestId('webhook-subscription-create-submit'));

    expect(createMutate).not.toHaveBeenCalled();
  });

  it('submitting a URL with one checked event type calls the create mutation with { targetUrl, eventTypes: [that type] }', async () => {
    mockQuery({ subscriptions: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(
      screen.getByTestId('webhook-subscription-url-input'),
      'https://example.com/hooks/lumina',
    );
    await user.click(screen.getByTestId('webhook-subscription-eventtype-ActionsProposed'));
    await user.click(screen.getByTestId('webhook-subscription-create-submit'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [variables] = createMutate.mock.calls[0] as [
      { targetUrl: string; eventTypes: string[] },
      ...unknown[],
    ];
    expect(variables).toEqual({
      targetUrl: 'https://example.com/hooks/lumina',
      eventTypes: ['ActionsProposed'],
    });
  });

  it('submitting a URL with BOTH event types checked calls the create mutation with both in eventTypes', async () => {
    mockQuery({ subscriptions: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(
      screen.getByTestId('webhook-subscription-url-input'),
      'https://example.com/hooks/lumina',
    );
    await user.click(screen.getByTestId('webhook-subscription-eventtype-ActionsProposed'));
    await user.click(screen.getByTestId('webhook-subscription-eventtype-ActionsDecided'));
    await user.click(screen.getByTestId('webhook-subscription-create-submit'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [variables] = createMutate.mock.calls[0] as [
      { targetUrl: string; eventTypes: string[] },
      ...unknown[],
    ];
    expect(variables.targetUrl).toEqual('https://example.com/hooks/lumina');
    expect(variables.eventTypes).toEqual(
      expect.arrayContaining(['ActionsProposed', 'ActionsDecided']),
    );
    expect(variables.eventTypes).toHaveLength(2);
  });

  it('on successful creation, switches to a reveal state showing the signingSecret and a one-time warning', async () => {
    mockQuery({ subscriptions: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();
    const signingSecret = 'whsec_FIXTURE_SIGNING_SECRET_VALUE_ONLY_SHOWN_ONCE';

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(
      screen.getByTestId('webhook-subscription-url-input'),
      'https://example.com/hooks/lumina',
    );
    await user.click(screen.getByTestId('webhook-subscription-eventtype-ActionsProposed'));
    await user.click(screen.getByTestId('webhook-subscription-create-submit'));

    const [, options] = createMutate.mock.calls[0] as [
      unknown,
      { onSuccess?: (data: { subscription: CreatedWebhookSubscription }) => void } | undefined,
    ];
    act(() => {
      options?.onSuccess?.({
        subscription: {
          ...makeSubscriptionFixture({ id: 'sub-new' }),
          signingSecret,
        },
      });
    });

    expect(screen.getByTestId('webhook-subscription-reveal')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-subscription-secret')).toHaveTextContent(signingSecret);
    expect(screen.getByTestId('webhook-subscription-reveal-warning')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-subscription-reveal-warning').textContent).not.toHaveLength(
      0,
    );
  });

  it('closing the dialog after reveal returns to the list view and the secret no longer appears anywhere', async () => {
    mockQuery({ subscriptions: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();
    const signingSecret = 'whsec_FIXTURE_SIGNING_SECRET_VALUE_ONLY_SHOWN_ONCE';

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(
      screen.getByTestId('webhook-subscription-url-input'),
      'https://example.com/hooks/lumina',
    );
    await user.click(screen.getByTestId('webhook-subscription-eventtype-ActionsProposed'));
    await user.click(screen.getByTestId('webhook-subscription-create-submit'));

    const [, options] = createMutate.mock.calls[0] as [
      unknown,
      { onSuccess?: (data: { subscription: CreatedWebhookSubscription }) => void } | undefined,
    ];
    act(() => {
      options?.onSuccess?.({
        subscription: {
          ...makeSubscriptionFixture({ id: 'sub-new' }),
          signingSecret,
        },
      });
    });

    await user.click(screen.getByTestId('webhook-subscription-reveal-close'));

    expect(screen.queryByTestId('webhook-subscription-dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(signingSecret);
  });

  it('sources identity only from the workspaceId prop -- every hook is called with exactly that value', async () => {
    mockQuery({ subscriptions: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<WebhookSubscriptionsPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    expect(mockedUseWebhookSubscriptionsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseCreateWebhookSubscriptionMutation).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseDeleteWebhookSubscriptionMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [
      mockedUseWebhookSubscriptionsQuery,
      mockedUseCreateWebhookSubscriptionMutation,
      mockedUseDeleteWebhookSubscriptionMutation,
    ]) {
      for (const call of mockedHook.mock.calls as unknown[][]) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});
