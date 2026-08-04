import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReminderPicker } from './ReminderPicker.js';
import { useSetFieldValuesMutation } from '../../hooks/useObjectsQuery.js';

import type { OptimisticContext } from '../../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/detail/ReminderPicker.tsx to satisfy these tests.
 * That's the expected TDD red state — this file fails to even resolve its
 * own `./ReminderPicker.js` import until the component exists.
 *
 *   export interface ReminderPickerProps {
 *     workspaceId: string;
 *     objectId: string;
 *     remindAt: unknown;             // object's current fieldValues.remindAt
 *     remindAcknowledged: unknown;   // object's current fieldValues.remindAcknowledged
 *   }
 *   export function ReminderPicker(props: ReminderPickerProps): React.JSX.Element;
 *
 * Mirrors `StatusPrioritySelect`'s own `currentValue: unknown` convention —
 * both `remindAt`/`remindAcknowledged` are ORDINARY Custom Fields (F1-T10
 * PR5, auto-seeded, already fully readable/writable via the EXISTING
 * `PATCH .../objects/:objectId/fields` route) and this component narrows
 * each `unknown` prop internally rather than the parent panel doing so.
 *
 * DESIGN DECISION — reuses `useSetFieldValuesMutation(workspaceId)`
 * (../../hooks/useObjectsQuery.js, mocked wholesale below, the same way
 * StatusPrioritySelect.test.tsx mocks it) UNCHANGED — NO new dedicated
 * mutation hook, per the plan's own text ("mevcut useSetFieldValuesMutation
 * değişmeden kullanılır", unlike `RecurrenceRulePicker`, which needs its own
 * hook because recurrenceRule is served by a dedicated, non-shared route).
 * Exactly one `useSetFieldValuesMutation(workspaceId)` call backs BOTH the
 * datetime field and the checkbox field. Mirrors StatusPrioritySelect.tsx's
 * exact per-call `onSuccess` cache-invalidation pattern: every `mutate(...)`
 * call passes `{ onSuccess: () => queryClient.invalidateQueries({ queryKey:
 * ['object', workspaceId, objectId] }) }` as its second argument, closing the
 * same single-object cache gap StatusPrioritySelect.tsx's own contract
 * comment documents, without touching the shared hook itself. Requires a
 * real (non-mocked) `QueryClientProvider` ancestor for the component's own
 * `useQueryClient()` call to resolve — provided by this file's
 * `createWrapper()`, mirroring StatusPrioritySelect.test.tsx's own pattern.
 *
 * `remindAt` — a `@luminaos/ui` `DateTimePicker` (`mode="datetime-local"`,
 * data-testid="reminder-remind-at-input", `aria-label`="Hatırlatma zamanı").
 * `remindAt` is narrowed to `string | undefined` (any non-string value,
 * including `undefined`, renders an empty input) — DESIGN NOTE: no
 * ISO<->local format conversion is performed; the raw string value (already
 * `datetime-local`-input-compatible, e.g. `"2026-08-10T09:00"`) is used
 * verbatim as both the input's displayed `value` and the value forwarded to
 * `mutate` on change (mirrors `endDate`'s own "no format conversion, already
 * native-input-compatible" note in RecurrenceRulePicker's contract). Calling
 * `fireEvent.change`/typing a new value on this input calls
 * `mutate({ objectId, values: { remindAt: <new value> } },
 * { onSuccess: ... })` immediately (no separate save button — direct-commit,
 * same as `StatusPrioritySelect`'s `onValueChange`).
 *
 * `remindAcknowledged` — a `@luminaos/ui` `Checkbox`
 * (data-testid="reminder-remind-acknowledged-checkbox",
 * `aria-label`="Hatırlatma onaylandı"). Narrowed to `boolean` (any
 * non-boolean value, including `undefined`, renders unchecked/`false`).
 * Toggling it calls `mutate({ objectId, values: { remindAcknowledged: <new
 * boolean> } }, { onSuccess: ... })`.
 */

vi.mock('../../hooks/useObjectsQuery.js', () => ({
  useSetFieldValuesMutation: vi.fn(),
}));

const mockedUseSetFieldValuesMutation = vi.mocked(useSetFieldValuesMutation);

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

type MutateCall = (
  vars: { objectId: string; values: Record<string, unknown> },
  options?: { onSuccess?: () => void },
) => void;

function mockMutation(): ReturnType<typeof vi.fn<MutateCall>> {
  const mutate = vi.fn<MutateCall>();
  mockedUseSetFieldValuesMutation.mockReturnValue({
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  } as unknown as UseMutationResult<
    { object: ObjectWithFieldValues },
    Error,
    { objectId: string; values: Record<string, unknown> },
    OptimisticContext
  >);
  return mutate;
}

const workspaceId = 'ws-1';
const objectId = 'obj-1';

afterEach(() => {
  vi.clearAllMocks();
});

describe('ReminderPicker', () => {
  it('renders the current remindAt value in the datetime input', () => {
    mockMutation();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt="2026-08-10T09:00"
        remindAcknowledged={false}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('reminder-remind-at-input')).toHaveValue('2026-08-10T09:00');
  });

  it('renders an empty datetime input when remindAt is not a string (e.g. undefined)', () => {
    mockMutation();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={false}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('reminder-remind-at-input')).toHaveValue('');
  });

  it("renders remindAcknowledged's checked state (true)", () => {
    mockMutation();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={true}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('reminder-remind-acknowledged-checkbox')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('renders remindAcknowledged as unchecked when it is not a boolean (e.g. undefined)', () => {
    mockMutation();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={undefined}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('reminder-remind-acknowledged-checkbox')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls mutate({ objectId, values: { remindAt: <new value> } }) when the datetime value changes', async () => {
    const mutate = mockMutation();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={false}
      />,
      { wrapper: Wrapper },
    );

    const input = screen.getByTestId('reminder-remind-at-input');
    input.focus();
    await user.paste('2026-09-01T10:30');

    expect(mutate).toHaveBeenCalled();
    const [variables] = mutate.mock.calls.at(-1) as [
      { objectId: string; values: Record<string, unknown> },
    ];
    expect(variables).toEqual({ objectId, values: { remindAt: '2026-09-01T10:30' } });
  });

  it('calls mutate({ objectId, values: { remindAcknowledged: true } }) when the checkbox is checked', async () => {
    const mutate = mockMutation();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={false}
      />,
      { wrapper: Wrapper },
    );

    await user.click(screen.getByTestId('reminder-remind-acknowledged-checkbox'));

    expect(mutate.mock.calls[0]?.[0]).toEqual({
      objectId,
      values: { remindAcknowledged: true },
    });
  });

  it('calls mutate({ objectId, values: { remindAcknowledged: false } }) when the checked checkbox is unchecked', async () => {
    const mutate = mockMutation();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={true}
      />,
      { wrapper: Wrapper },
    );

    await user.click(screen.getByTestId('reminder-remind-acknowledged-checkbox'));

    expect(mutate.mock.calls[0]?.[0]).toEqual({
      objectId,
      values: { remindAcknowledged: false },
    });
  });

  it("invalidates the single-object query cache (['object', workspaceId, objectId]) via a per-call onSuccess passed to mutate, on the checkbox toggle", async () => {
    const mutate = mockMutation();
    const user = userEvent.setup();
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt={undefined}
        remindAcknowledged={false}
      />,
      { wrapper: Wrapper },
    );

    await user.click(screen.getByTestId('reminder-remind-acknowledged-checkbox'));

    // The mutation itself is mocked (never actually resolves), so this
    // simulates react-query invoking the per-call onSuccess it was handed —
    // the same "extract and invoke the captured callback directly" pattern
    // StatusPrioritySelect.test.tsx uses.
    const onSuccess = mutate.mock.calls[0]?.[1]?.onSuccess;
    expect(onSuccess).toBeDefined();
    onSuccess?.();

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey).toEqual(['object', workspaceId, objectId]);
  });

  it('does not call the mutation merely from rendering (no spurious call on mount)', () => {
    const mutate = mockMutation();
    const { Wrapper } = createWrapper();

    render(
      <ReminderPicker
        workspaceId={workspaceId}
        objectId={objectId}
        remindAt="2026-08-10T09:00"
        remindAcknowledged={true}
      />,
      { wrapper: Wrapper },
    );

    expect(mutate).not.toHaveBeenCalled();
  });
});
