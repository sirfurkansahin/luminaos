import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemoryRecord } from '@luminaos/memory';

import { MemoryImportWizard } from './MemoryImportWizard.js';
import { useCreateMemoryRecordMutation } from '../../hooks/useMemoryRecordsQuery.js';
import { parseImportInput } from '../../lib/parseImportInput.js';

import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F2-T7 PR2 (ADR-0023 §a/f) — genel-format bellek içe aktarma sihirbazı.
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/MemoryImportWizard.tsx to satisfy these tests.
 * That's the expected TDD red state.):
 *
 *   export interface MemoryImportWizardProps {
 *     workspaceId: string;
 *   }
 *   export function MemoryImportWizard(props: MemoryImportWizardProps): React.JSX.Element;
 *
 * `useCreateMemoryRecordMutation` (../../hooks/useMemoryRecordsQuery.js) and
 * `parseImportInput` (../../lib/parseImportInput.js) are BOTH mocked
 * wholesale below. `parseImportInput` is mocked (rather than exercised for
 * real, even though it's a pure function) deliberately: its exact shape-1
 * vs shape-2 detection contract has an unresolved doc-vs-code discrepancy
 * (see parseImportInput.test.ts's top-of-file comment) — mocking it here
 * keeps this suite's pass/fail independent of how that discrepancy gets
 * resolved. `parseImportInput`'s own contract is pinned separately by
 * parseImportInput.test.ts, not here.
 *
 * Always-visible trigger:
 *   - data-testid="memory-import-trigger", text "Bellek Kayıtlarını İçe
 *     Aktar" (hardcoded Turkish, this repo has no i18n catalog, mirrors
 *     MemoryPassportPanel.tsx's precedent).
 *
 * Dialog (data-testid="memory-import-dialog"):
 *   - NOT in the document by default; opens on trigger click.
 *   - Always contains a close affordance (data-testid="memory-import-close")
 *     regardless of which step is active; clicking it closes the dialog
 *     (removes it from the document) — this is the wizard's only pinned
 *     close mechanism, no other close behavior is asserted here.
 *
 * Step 1 — paste (shown immediately once the dialog opens):
 *   - data-testid="memory-import-textarea" — a controlled textarea, starts
 *     empty.
 *   - data-testid="memory-import-continue" — a button that is `disabled`
 *     whenever the textarea's trimmed value is empty, and enabled
 *     otherwise. Clicking it while enabled calls
 *     `parseImportInput(<the textarea's current raw value>)` exactly once
 *     and advances to step 2 using its return value.
 *
 * Step 2 — preview (shown after a successful "Devam Et"):
 *   - data-testid="memory-import-preview" — wrapping container.
 *   - data-testid="memory-import-preview-count" — text content EXACTLY
 *     `${parsedItems.length} kayıt bulundu`.
 *   - data-testid=`memory-import-preview-item-${index}` — one per parsed
 *     item (0-based index into the array `parseImportInput` returned),
 *     text content equal to that item's raw string content.
 *   - data-testid="memory-import-confirm" — a button. Clicking it calls
 *     `useCreateMemoryRecordMutation(workspaceId)`'s `mutateAsync` ONCE PER
 *     parsed item, each call's sole argument being `{ content: <item> }`,
 *     in the SAME order as the parsed array (Promise.allSettled semantics
 *     per ADR-0023 §f — every item's mutateAsync call fires regardless of
 *     whether an earlier one has already rejected; a rejection is never
 *     silently swallowed and never aborts the remaining calls).
 *
 * Step 3 — result (shown once every mutateAsync call for the current
 * import batch has settled, success or failure):
 *   - data-testid="memory-import-result" — wrapping container.
 *   - data-testid="memory-import-result-summary" — text content EXACTLY
 *     `${successCount} başarılı, ${failureCount} başarısız`.
 *   - data-testid=`memory-import-result-success-${index}` — one per
 *     successfully-imported item (same 0-based index as step 2's preview
 *     rows), text content equal to that item's raw string content.
 *   - data-testid=`memory-import-result-failure-${index}` — one per
 *     FAILED item, text content equal to that item's raw string content
 *     (this is the pinned "never silently swallowed" acceptance
 *     criterion — a failed item must be distinguishably rendered, not
 *     just omitted).
 *
 * Security/identity invariant: `useCreateMemoryRecordMutation` is called
 * with exactly the `workspaceId` prop, mirroring MemoryPassportPanel's
 * precedent — there is no separate userId prop.
 */

vi.mock('../../hooks/useMemoryRecordsQuery.js', () => ({
  useCreateMemoryRecordMutation: vi.fn(),
}));

vi.mock('../../lib/parseImportInput.js', () => ({
  parseImportInput: vi.fn(),
}));

const mockedUseCreateMemoryRecordMutation = vi.mocked(useCreateMemoryRecordMutation);
const mockedParseImportInput = vi.mocked(parseImportInput);

const workspaceId = 'ws-1';

function makeMemoryRecordFixture(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    workspaceId,
    userId: 'user-1',
    content: 'İçe aktarılan kayıt.',
    kaynakOlayId: 'evt-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function mockMutateAsync(
  mutateAsync: (variables: { content: string }) => Promise<{ record: MemoryRecord }>,
): void {
  mockedUseCreateMemoryRecordMutation.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  } as unknown as UseMutationResult<{ record: MemoryRecord }, Error, { content: string }>);
}

async function openWizard(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('memory-import-trigger'));
}

async function goToPreview(
  user: ReturnType<typeof userEvent.setup>,
  pastedText: string,
): Promise<void> {
  await user.type(screen.getByTestId('memory-import-textarea'), pastedText);
  await user.click(screen.getByTestId('memory-import-continue'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MemoryImportWizard', () => {
  it('always renders a visible trigger button with the Turkish label "Bellek Kayıtlarını İçe Aktar"', () => {
    render(<MemoryImportWizard workspaceId={workspaceId} />);

    const trigger = screen.getByTestId('memory-import-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Bellek Kayıtlarını İçe Aktar');
  });

  it('does not render the dialog by default (closed)', () => {
    render(<MemoryImportWizard workspaceId={workspaceId} />);

    expect(screen.queryByTestId('memory-import-dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog when the trigger button is clicked', async () => {
    const user = userEvent.setup();
    render(<MemoryImportWizard workspaceId={workspaceId} />);

    await openWizard(user);

    expect(screen.getByTestId('memory-import-dialog')).toBeInTheDocument();
  });

  it('closes the dialog when the close affordance is clicked', async () => {
    const user = userEvent.setup();
    render(<MemoryImportWizard workspaceId={workspaceId} />);

    await openWizard(user);
    expect(screen.getByTestId('memory-import-dialog')).toBeInTheDocument();

    await user.click(screen.getByTestId('memory-import-close'));

    expect(screen.queryByTestId('memory-import-dialog')).not.toBeInTheDocument();
  });

  describe('step 1 — paste', () => {
    it('renders an empty textarea and a disabled "Devam Et" button while it is empty', async () => {
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);

      expect(screen.getByTestId('memory-import-textarea')).toHaveValue('');
      expect(screen.getByTestId('memory-import-continue')).toBeDisabled();
    });

    it('keeps "Devam Et" disabled for whitespace-only input', async () => {
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);
      await user.type(screen.getByTestId('memory-import-textarea'), '   \n  ');

      expect(screen.getByTestId('memory-import-continue')).toBeDisabled();
    });

    it('enables "Devam Et" once the textarea has non-empty content', async () => {
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);
      await user.type(screen.getByTestId('memory-import-textarea'), 'Bir not');

      expect(screen.getByTestId('memory-import-continue')).toBeEnabled();
    });

    it('calls parseImportInput with the textarea’s raw value and advances to the preview step on "Devam Et"', async () => {
      mockedParseImportInput.mockReturnValue(['Birinci not']);
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);
      await goToPreview(user, 'Birinci not');

      expect(mockedParseImportInput).toHaveBeenCalledTimes(1);
      expect(mockedParseImportInput).toHaveBeenCalledWith('Birinci not');
      expect(screen.getByTestId('memory-import-preview')).toBeInTheDocument();
    });
  });

  describe('step 2 — preview', () => {
    it('shows the parsed item count and each parsed item’s content', async () => {
      mockedParseImportInput.mockReturnValue(['Birinci not', 'İkinci not']);
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);
      await goToPreview(user, 'girdi metni');

      expect(screen.getByTestId('memory-import-preview-count')).toHaveTextContent(
        '2 kayıt bulundu',
      );
      expect(screen.getByTestId('memory-import-preview-item-0')).toHaveTextContent('Birinci not');
      expect(screen.getByTestId('memory-import-preview-item-1')).toHaveTextContent('İkinci not');
      expect(screen.getByTestId('memory-import-confirm')).toBeInTheDocument();
    });
  });

  describe('step 3 — result: all items succeed', () => {
    it('calls mutateAsync once per parsed item with { content: item } and shows a success summary', async () => {
      mockedParseImportInput.mockReturnValue(['Birinci not', 'İkinci not']);
      const mutateAsync = vi
        .fn()
        .mockImplementation((input: { content: string }) =>
          Promise.resolve({ record: makeMemoryRecordFixture(input) }),
        );
      mockMutateAsync(mutateAsync);
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);
      await goToPreview(user, 'girdi metni');
      await user.click(screen.getByTestId('memory-import-confirm'));

      await waitFor(() => {
        expect(screen.getByTestId('memory-import-result')).toBeInTheDocument();
      });

      expect(mutateAsync).toHaveBeenCalledTimes(2);
      expect(mutateAsync).toHaveBeenNthCalledWith(1, { content: 'Birinci not' });
      expect(mutateAsync).toHaveBeenNthCalledWith(2, { content: 'İkinci not' });

      expect(screen.getByTestId('memory-import-result-summary')).toHaveTextContent(
        '2 başarılı, 0 başarısız',
      );
      expect(screen.getByTestId('memory-import-result-success-0')).toHaveTextContent('Birinci not');
      expect(screen.getByTestId('memory-import-result-success-1')).toHaveTextContent('İkinci not');
      expect(screen.queryByTestId('memory-import-result-failure-0')).not.toBeInTheDocument();
      expect(screen.queryByTestId('memory-import-result-failure-1')).not.toBeInTheDocument();
    });
  });

  describe('step 3 — result: a partial failure is never silently swallowed', () => {
    it('shows per-item success/failure — the failed item is distinguishably rendered as failed, and the other items still succeed', async () => {
      mockedParseImportInput.mockReturnValue(['A', 'B', 'C']);
      const mutateAsync = vi.fn().mockImplementation((input: { content: string }) => {
        if (input.content === 'B') {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve({ record: makeMemoryRecordFixture(input) });
      });
      mockMutateAsync(mutateAsync);
      const user = userEvent.setup();
      render(<MemoryImportWizard workspaceId={workspaceId} />);

      await openWizard(user);
      await goToPreview(user, 'girdi metni');
      await user.click(screen.getByTestId('memory-import-confirm'));

      await waitFor(() => {
        expect(screen.getByTestId('memory-import-result')).toBeInTheDocument();
      });

      // Every item's mutateAsync call fires — an earlier rejection (none
      // here, order-independent regardless) never aborts the remaining
      // calls (ADR-0023 §f Promise.allSettled semantics).
      expect(mutateAsync).toHaveBeenCalledTimes(3);
      expect(mutateAsync).toHaveBeenNthCalledWith(1, { content: 'A' });
      expect(mutateAsync).toHaveBeenNthCalledWith(2, { content: 'B' });
      expect(mutateAsync).toHaveBeenNthCalledWith(3, { content: 'C' });

      expect(screen.getByTestId('memory-import-result-summary')).toHaveTextContent(
        '2 başarılı, 1 başarısız',
      );
      expect(screen.getByTestId('memory-import-result-success-0')).toHaveTextContent('A');
      expect(screen.getByTestId('memory-import-result-failure-1')).toHaveTextContent('B');
      expect(screen.getByTestId('memory-import-result-success-2')).toHaveTextContent('C');

      // The failed item must never appear disguised as a success row.
      expect(screen.queryByTestId('memory-import-result-success-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('memory-import-result-failure-0')).not.toBeInTheDocument();
      expect(screen.queryByTestId('memory-import-result-failure-2')).not.toBeInTheDocument();
    });
  });

  it('sources identity only from the workspaceId prop — the mutation hook is called with exactly that value', async () => {
    mockedParseImportInput.mockReturnValue(['Bir not']);
    mockMutateAsync(vi.fn().mockResolvedValue({ record: makeMemoryRecordFixture() }));
    const user = userEvent.setup();
    render(<MemoryImportWizard workspaceId={workspaceId} />);

    await openWizard(user);
    await goToPreview(user, 'girdi metni');

    expect(mockedUseCreateMemoryRecordMutation).toHaveBeenCalledWith(workspaceId);
    for (const call of mockedUseCreateMemoryRecordMutation.mock.calls) {
      expect(call).toEqual([workspaceId]);
    }
  });
});
