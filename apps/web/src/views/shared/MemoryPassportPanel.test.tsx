import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemoryRecord } from '@luminaos/memory';

import { MemoryPassportPanel } from './MemoryPassportPanel.js';
import {
  useCreateMemoryRecordMutation,
  useDeleteMemoryRecordMutation,
  useMemoryRecordsQuery,
  useUpdateMemoryRecordMutation,
} from '../../hooks/useMemoryRecordsQuery.js';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T6 — "Hakkımda ne biliyorsun?" ekranı. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/views/shared/MemoryPassportPanel.tsx to satisfy these tests.
 * That's the expected TDD red state.):
 *
 *   export interface MemoryPassportPanelProps {
 *     workspaceId: string;
 *   }
 *   export function MemoryPassportPanel(props: MemoryPassportPanelProps): React.JSX.Element;
 *
 * - Always renders a visible trigger button
 *   (data-testid="memory-passport-trigger", text "Hakkımda ne biliyorsun?" —
 *   hardcoded Turkish, this repo has no i18n catalog). Unlike CommandPalette
 *   (opened via a hidden global Cmd/Ctrl+K shortcut), this panel opens via a
 *   plain visible `onClick={() => setOpen(true)}` button — discoverability
 *   matters here.
 * - The dialog (data-testid="memory-passport-dialog") is NOT in the document
 *   by default; clicking the trigger opens it.
 * - Once open, useMemoryRecordsQuery(workspaceId)'s state drives one of four
 *   presentational states, mirroring SavedViewsList's four-state shape:
 *     - isLoading: true              -> data-testid="memory-passport-loading"
 *     - isError: true                -> data-testid="memory-passport-error"
 *     - data.records.length === 0    -> data-testid="memory-passport-empty"
 *     - otherwise                    -> one row per record,
 *       data-testid=`memory-record-item-${record.id}`
 * - Each record row shows its `content` text and a source-trace string
 *   derived from `createdAt` ONLY — `kaynakOlayId`'s raw UUID must never
 *   appear anywhere in the rendered DOM (ADR-0022: in v1 it is always
 *   self-referential to the record's own creation event and carries no
 *   meaningful information to the user).
 * - Each record row has an edit affordance
 *   (data-testid=`memory-record-edit-${record.id}`) and a delete affordance
 *   (data-testid=`memory-record-delete-${record.id}`); clicking delete calls
 *   the delete mutation's `mutate` with the record's `id`.
 * - A create form is present when the panel is open: a text input
 *   (data-testid="memory-passport-create-input") and a submit button
 *   (data-testid="memory-passport-create-submit"). Submitting with non-empty
 *   content calls the create mutation's `mutate` with `{ content: <value> }`.
 * - Security invariant: the component sources identity ONLY from the
 *   `workspaceId` prop — useMemoryRecordsQuery/the mutations are always
 *   called with exactly that prop value, never anything else (there is no
 *   userId prop at all).
 *
 * useMemoryRecordsQuery/useCreateMemoryRecordMutation/
 * useUpdateMemoryRecordMutation/useDeleteMemoryRecordMutation are mocked
 * wholesale below — their own contract is pinned separately by
 * useMemoryRecordsQuery.test.ts, not here.
 */

vi.mock('../../hooks/useMemoryRecordsQuery.js', () => ({
  useMemoryRecordsQuery: vi.fn(),
  useCreateMemoryRecordMutation: vi.fn(),
  useUpdateMemoryRecordMutation: vi.fn(),
  useDeleteMemoryRecordMutation: vi.fn(),
}));

const mockedUseMemoryRecordsQuery = vi.mocked(useMemoryRecordsQuery);
const mockedUseCreateMemoryRecordMutation = vi.mocked(useCreateMemoryRecordMutation);
const mockedUseUpdateMemoryRecordMutation = vi.mocked(useUpdateMemoryRecordMutation);
const mockedUseDeleteMemoryRecordMutation = vi.mocked(useDeleteMemoryRecordMutation);

const workspaceId = 'ws-1';

function makeMemoryRecordFixture(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    workspaceId,
    userId: 'user-1',
    content: 'Kahve yerine çay tercih ederim.',
    kaynakOlayId: 'evt-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function mockQuery(
  data: { records: MemoryRecord[] } | undefined,
  overrides: Partial<UseQueryResult<{ records: MemoryRecord[] }>> = {},
): void {
  mockedUseMemoryRecordsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as UseQueryResult<{ records: MemoryRecord[] }>);
}

function makeMutationResultBase(mutate: (variables: never) => void): Record<string, unknown> {
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

function makeMutationResult<TData, TVariables>(
  mutate: (variables: TVariables) => void,
): UseMutationResult<TData, Error, TVariables> {
  return makeMutationResultBase(mutate) as unknown as UseMutationResult<TData, Error, TVariables>;
}

function makeVoidMutationResult<TVariables>(
  mutate: (variables: TVariables) => void,
): UseMutationResult<void, Error, TVariables> {
  return makeMutationResultBase(mutate) as unknown as UseMutationResult<void, Error, TVariables>;
}

function mockMutations(): {
  createMutate: ReturnType<typeof vi.fn>;
  updateMutate: ReturnType<typeof vi.fn>;
  deleteMutate: ReturnType<typeof vi.fn>;
} {
  const createMutate = vi.fn();
  const updateMutate = vi.fn();
  const deleteMutate = vi.fn();

  mockedUseCreateMemoryRecordMutation.mockReturnValue(
    makeMutationResult<{ record: MemoryRecord }, { content: string }>(createMutate),
  );
  mockedUseUpdateMemoryRecordMutation.mockReturnValue(
    makeMutationResult<{ record: MemoryRecord }, { recordId: string; input: { content: string } }>(
      updateMutate,
    ),
  );
  mockedUseDeleteMemoryRecordMutation.mockReturnValue(makeVoidMutationResult(deleteMutate));

  return { createMutate, updateMutate, deleteMutate };
}

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('memory-passport-trigger'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MemoryPassportPanel', () => {
  it('always renders a visible trigger button with the Turkish label "Hakkımda ne biliyorsun?"', () => {
    mockQuery({ records: [] });
    mockMutations();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);

    const trigger = screen.getByTestId('memory-passport-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Hakkımda ne biliyorsun?');
  });

  it('does not render the dialog by default (closed)', () => {
    mockQuery({ records: [] });
    mockMutations();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);

    expect(screen.queryByTestId('memory-passport-dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog when the trigger button is clicked', async () => {
    mockQuery({ records: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(screen.getByTestId('memory-passport-dialog')).toBeInTheDocument();
  });

  it('renders a loading state (data-testid="memory-passport-loading") while the query is loading', async () => {
    mockQuery(undefined, { isLoading: true });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(screen.getByTestId('memory-passport-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="memory-passport-error") when the query isError', async () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(screen.getByTestId('memory-passport-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="memory-passport-empty") when there are no records', async () => {
    mockQuery({ records: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(screen.getByTestId('memory-passport-empty')).toBeInTheDocument();
  });

  it('renders one row per record, showing its content but never its raw kaynakOlayId UUID', async () => {
    const record = makeMemoryRecordFixture({
      id: 'mem-1',
      content: 'Kahve yerine çay tercih ederim.',
      kaynakOlayId: 'evt-super-secret-uuid-1234',
    });
    mockQuery({ records: [record] });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    const item = screen.getByTestId('memory-record-item-mem-1');
    expect(item).toHaveTextContent('Kahve yerine çay tercih ederim.');

    const dialog = screen.getByTestId('memory-passport-dialog');
    expect(dialog.textContent).not.toContain('evt-super-secret-uuid-1234');
  });

  it('renders an edit and a delete affordance for each record', async () => {
    const record = makeMemoryRecordFixture({ id: 'mem-1' });
    mockQuery({ records: [record] });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(screen.getByTestId('memory-record-edit-mem-1')).toBeInTheDocument();
    expect(screen.getByTestId('memory-record-delete-mem-1')).toBeInTheDocument();
  });

  it('calls the delete mutation with the record id when the delete affordance is clicked', async () => {
    const record = makeMemoryRecordFixture({ id: 'mem-1' });
    mockQuery({ records: [record] });
    const { deleteMutate } = mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    await user.click(screen.getByTestId('memory-record-delete-mem-1'));

    expect(deleteMutate).toHaveBeenCalledWith('mem-1');
  });

  it('renders a create form (input + submit) while the panel is open', async () => {
    mockQuery({ records: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(screen.getByTestId('memory-passport-create-input')).toBeInTheDocument();
    expect(screen.getByTestId('memory-passport-create-submit')).toBeInTheDocument();
  });

  it('calls the create mutation with { content } when the create form is submitted with non-empty content', async () => {
    mockQuery({ records: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    await user.type(screen.getByTestId('memory-passport-create-input'), 'Yeni bir bilgi kaydı.');
    await user.click(screen.getByTestId('memory-passport-create-submit'));

    expect(createMutate).toHaveBeenCalledWith({ content: 'Yeni bir bilgi kaydı.' });
  });

  it('sources identity only from the workspaceId prop — every hook is called with exactly that value', async () => {
    mockQuery({ records: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<MemoryPassportPanel workspaceId={workspaceId} />);
    await openPanel(user);

    expect(mockedUseMemoryRecordsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseCreateMemoryRecordMutation).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseUpdateMemoryRecordMutation).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseDeleteMemoryRecordMutation).toHaveBeenCalledWith(workspaceId);

    // No hook should ever have been called with anything other than the
    // single `workspaceId` prop value (e.g. a stray userId, or a second
    // positional argument sourced from elsewhere).
    for (const mockedHook of [
      mockedUseMemoryRecordsQuery,
      mockedUseCreateMemoryRecordMutation,
      mockedUseUpdateMemoryRecordMutation,
      mockedUseDeleteMemoryRecordMutation,
    ]) {
      for (const call of mockedHook.mock.calls) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});
