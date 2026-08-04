import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinition } from '@luminaos/core-objects';

import { StatusPrioritySelect } from './StatusPrioritySelect.js';
import { useSetFieldValuesMutation } from '../../hooks/useObjectsQuery.js';

import type { OptimisticContext } from '../../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/detail/StatusPrioritySelect.tsx to satisfy these
 * tests. That's the expected TDD red state — this file fails to even
 * resolve its own `./StatusPrioritySelect.js` import until the component
 * exists.):
 *
 *   export interface StatusPrioritySelectProps {
 *     workspaceId: string;
 *     objectId: string;
 *     fieldKey: string;            // 'status' | 'priority'
 *     fieldDefinition: FieldDefinition; // already-fetched by the parent
 *                                       // panel via useFieldDefinitionsQuery
 *                                       // and passed down — this component
 *                                       // never fetches its own definition.
 *     currentValue: unknown;       // object's current fieldValues[fieldKey]
 *   }
 *   export function StatusPrioritySelect(props: StatusPrioritySelectProps): React.JSX.Element;
 *
 * Built on `@luminaos/ui`'s real (non-mocked) `SelectRoot`/`SelectTrigger`/
 * `SelectValue`/`SelectContent`/`SelectItem`
 * (packages/ui/src/components/Select/Select.tsx). `fieldDefinition.config`
 * is `unknown` at the type level (per
 * packages/core-objects/src/fields/field-definition.ts) — the component
 * narrows it into `{ options: { value: string; label: string; isDone?:
 * boolean }[] }` (the same shape packages/core-objects/src/fields/
 * field-type-registry.ts's `optionsConfigSchema` enforces server-side; a
 * client-side runtime guard, not necessarily importing that zod schema
 * directly, is an acceptable implementer choice — the server has already
 * validated this data, so this is a defensive narrow, not a duplicate
 * validation pass). Each option becomes one `SelectItem` (`value`=
 * option.value, visible text=option.label). `SelectTrigger`'s `aria-label`
 * is `fieldDefinition.label` directly (no `Label` wrapper — established
 * repo convention, see PR6e plan). `SelectRoot`'s `value` is `currentValue`
 * (cast/narrowed to `string | undefined`) so the trigger displays the
 * CURRENTLY SELECTED OPTION'S LABEL, never the raw stored value.
 *
 * DESIGN DECISION — optimistic-update / single-object cache gap (see task
 * brief): `useSetFieldValuesMutation(workspaceId)` (../../hooks/
 * useObjectsQuery.ts, mocked wholesale below, the same way
 * BoardView.test.tsx mocks it) is reused UNCHANGED, per the PR6e plan's own
 * text ("mevcut useSetFieldValuesMutation değişmeden kullanılır") — its
 * `onMutate`/`onError` optimistic machinery and its shared `onSuccess`
 * (`invalidateQueries(['objects', workspaceId])`) are untouched, so every
 * other consumer (List/Table/Board views) keeps behaving exactly as before.
 * That shared `onSuccess` does NOT invalidate `['object', workspaceId,
 * objectId]` — a different query-key prefix that
 * apps/web/src/hooks/useObjectsQuery.ts's `useObjectQuery` (consumed by
 * TaskDetailPanel) reads — so without extra wiring, a successful edit here
 * would leave the panel's OWN displayed value stale until the panel is
 * closed and reopened. This component closes that gap ITSELF, at the call
 * site, without touching the shared hook: it calls `mutate(variables, {
 * onSuccess: () => queryClient.invalidateQueries({ queryKey: ['object',
 * workspaceId, objectId] }) })` — react-query invokes BOTH the hook-level
 * `onSuccess` and this per-call `onSuccess`, so the shared hook's existing
 * behavior for other consumers is unaffected, and the single-object cache
 * additionally gets invalidated. This requires a real (non-mocked)
 * `QueryClientProvider` ancestor so the component's own `useQueryClient()`
 * call resolves — provided by this file's `createWrapper()`, mirroring
 * CreateObjectButton.test.tsx's pattern. The per-call `onSuccess` itself is
 * extracted from the mocked `mutate`'s captured call arguments and invoked
 * directly in tests (mirroring BoardView.test.tsx's per-call `onError`
 * extraction pattern) rather than waiting on the (mocked, so non-functional)
 * mutation to actually resolve.
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

function makeFieldDefinition(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
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
        { value: 'in_progress', label: 'Devam Ediyor' },
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

const workspaceId = 'ws-1';
const objectId = 'obj-1';

afterEach(() => {
  vi.clearAllMocks();
});

describe('StatusPrioritySelect', () => {
  it("exposes a combobox whose accessible name is the field definition's label", () => {
    mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue="todo"
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByRole('combobox', { name: 'Durum' })).toBeInTheDocument();
  });

  it("shows the currently selected option's LABEL (not its raw value) as the trigger's displayed text", () => {
    mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue="in_progress"
      />,
      { wrapper: Wrapper },
    );

    const combobox = screen.getByRole('combobox', { name: 'Durum' });
    expect(combobox).toHaveTextContent('Devam Ediyor');
    expect(combobox).not.toHaveTextContent('in_progress');
  });

  it('does not display any known option label when currentValue matches none of them (unselected)', () => {
    mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue={undefined}
      />,
      { wrapper: Wrapper },
    );

    const combobox = screen.getByRole('combobox', { name: 'Durum' });
    expect(combobox).not.toHaveTextContent('Yapılacak');
    expect(combobox).not.toHaveTextContent('Devam Ediyor');
    expect(combobox).not.toHaveTextContent('Tamamlandı');
  });

  it('lists every option from fieldDefinition.config.options (by label) when opened', async () => {
    mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue="todo"
      />,
      { wrapper: Wrapper },
    );

    await user.tab();
    await user.keyboard('{Enter}');

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.textContent)).toEqual([
      'Yapılacak',
      'Devam Ediyor',
      'Tamamlandı',
    ]);
  });

  it('calls the mutation with { objectId, values: { [fieldKey]: newValue } } when a different option is selected', async () => {
    const mutate = mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue="todo"
      />,
      { wrapper: Wrapper },
    );

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('option');
    // "todo" (index 0) starts focused as the already-selected value.
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(mutate.mock.calls[0]?.[0]).toEqual({
      objectId,
      values: { status: 'in_progress' },
    });
  });

  it('does not call the mutation merely from rendering (no spurious call on mount)', () => {
    const mutate = mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue="todo"
      />,
      { wrapper: Wrapper },
    );

    expect(mutate).not.toHaveBeenCalled();
  });

  it("invalidates the single-object query cache (['object', workspaceId, objectId]) via a per-call onSuccess passed to mutate", async () => {
    const mutate = mockMutation();
    const fieldDefinition = makeFieldDefinition();
    const user = userEvent.setup();
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="status"
        fieldDefinition={fieldDefinition}
        currentValue="todo"
      />,
      { wrapper: Wrapper },
    );

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('option');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    // The mutation itself is mocked (never actually resolves), so this
    // simulates react-query invoking the per-call onSuccess it was handed —
    // exactly the same "extract and invoke the captured callback directly"
    // pattern BoardView.test.tsx uses for its per-call onError.
    const onSuccess = mutate.mock.calls[0]?.[1]?.onSuccess;
    expect(onSuccess).toBeDefined();
    onSuccess?.();

    expect(invalidateSpy).toHaveBeenCalled();
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey).toEqual(['object', workspaceId, objectId]);
  });

  it('renders a priority selector identically when given the priority field definition/key', () => {
    mockMutation();
    const fieldDefinition = makeFieldDefinition({
      id: 'field-priority',
      key: 'priority',
      label: 'Öncelik',
      config: {
        options: [
          { value: 'low', label: 'Düşük' },
          { value: 'high', label: 'Yüksek' },
        ],
      },
    });
    const { Wrapper } = createWrapper();

    render(
      <StatusPrioritySelect
        workspaceId={workspaceId}
        objectId={objectId}
        fieldKey="priority"
        fieldDefinition={fieldDefinition}
        currentValue="high"
      />,
      { wrapper: Wrapper },
    );

    const combobox = screen.getByRole('combobox', { name: 'Öncelik' });
    expect(combobox).toHaveTextContent('Yüksek');
  });
});
