import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TriggerSuggestionsPanel as TriggerSuggestionsPanelModuleExport } from './TriggerSuggestionsPanel.js';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T17 PR3 (ADR-0034, spec Kabul Kriterleri: "bekleyen öneriler listesi +
 * gerekçe, 'Şimdi analiz et' butonu, onay/red aksiyonları") — TDD red step.
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/TriggerSuggestionsPanel.tsx to satisfy these
 * tests):
 *
 *   export interface TriggerSuggestionsPanelProps { workspaceId: string; }
 *   export function TriggerSuggestionsPanel(props: TriggerSuggestionsPanelProps): React.JSX.Element;
 *
 * Mirrors `AutomationHistoryPanel.tsx`'s exact combination of
 * `IntegrationsPanel.tsx`'s plain-list-no-dialog convention with real
 * approve/reject buttons wired to a decide mutation, PLUS a new
 * "Şimdi analiz et" trigger button wired to a separate no-argument analysis
 * mutation (this domain has no direct 1:1 template for the analyze button,
 * so its states are pinned in full below).
 *
 * Contract pinned:
 * - top-level states: isLoading (from the query) ->
 *   data-testid="trigger-suggestions-loading"; isError ->
 *   data-testid="trigger-suggestions-error".
 * - a "Şimdi analiz et" button, ALWAYS visible once loaded (regardless of
 *   whether there are pending suggestions) ->
 *   data-testid="trigger-suggestions-analyze-button". Clicking it calls the
 *   analyze mutation's `mutate` with NO arguments.
 * - while the analyze mutation isPending, the button is disabled
 *   (data-testid unchanged, just `toBeDisabled()`).
 * - if the analyze mutation isError (e.g. the cooldown-409 case), render a
 *   visible, non-fatal error message ->
 *   data-testid="trigger-suggestions-analyze-error" -- the REST of the panel
 *   still renders (this is a transient, retriable failure).
 * - zero PENDING suggestions (status === 'pending') ->
 *   data-testid="trigger-suggestions-pending-empty" (analyze button and any
 *   decided section still render).
 * - each PENDING suggestion -> data-testid=`trigger-suggestion-item-${id}`,
 *   text content includes BOTH `suggestion.name` AND `suggestion.rationale`,
 *   plus two buttons data-testid=`trigger-suggestion-approve-${id}` /
 *   data-testid=`trigger-suggestion-reject-${id}`.
 * - clicking approve/reject calls the decide mutation's `mutate` with
 *   EXACTLY `{ suggestionId: suggestion.id, decision: 'approve' | 'reject' }`.
 * - a DECIDED section -> data-testid="trigger-suggestion-decided-section"
 *   containing one row per suggestion with status !== 'pending' ->
 *   data-testid=`trigger-suggestion-decided-item-${id}` (read-only, NO
 *   approve/reject buttons anywhere inside), whose text content includes the
 *   suggestion's status somewhere.
 * - every hook is called with exactly `workspaceId`.
 *
 * `useTriggerSuggestionsQuery`/`useRunTriggerSuggestionsAnalysisMutation`/
 * `useDecideTriggerSuggestionMutation`
 * (../../hooks/useTriggerSuggestionsQuery.ts) do not exist yet, so --
 * mirroring `AutomationHistoryPanel.test.tsx`'s handling of the equally
 * not-yet-existing `useProposalsQuery` hooks -- mock functions are created via
 * `vi.hoisted` and referenced ONLY by closure inside the `vi.mock` factory
 * below; this file never imports that hook module itself. The
 * `TriggerTemplateSuggestionSummary`/`TriggerSpecSummary` shapes are declared
 * locally for the same reason. `./TriggerSuggestionsPanel.tsx` itself DOES
 * NOT exist yet either -- imported directly (`ModuleExport` cast), so this
 * test file is expected to fail to even resolve that import until the
 * component exists -- the documented TDD red state.
 */

type TriggerSpecSummary =
  | { kind: 'scheduled'; intervalMinutes: number; actionTemplate: { title: string } }
  | {
      kind: 'condition';
      objectType: string;
      fieldKey: string;
      pattern: string;
      flags: string;
      actionTemplate: { title: string };
    };

interface TriggerTemplateSuggestionSummary {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'scheduled' | 'condition';
  spec: TriggerSpecSummary;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  createdTriggerId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const {
  mockedUseTriggerSuggestionsQuery,
  mockedUseRunTriggerSuggestionsAnalysisMutation,
  mockedUseDecideTriggerSuggestionMutation,
} = vi.hoisted(() => {
  return {
    mockedUseTriggerSuggestionsQuery: vi.fn(),
    mockedUseRunTriggerSuggestionsAnalysisMutation: vi.fn(),
    mockedUseDecideTriggerSuggestionMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useTriggerSuggestionsQuery.js', () => ({
  useTriggerSuggestionsQuery: mockedUseTriggerSuggestionsQuery,
  useRunTriggerSuggestionsAnalysisMutation: mockedUseRunTriggerSuggestionsAnalysisMutation,
  useDecideTriggerSuggestionMutation: mockedUseDecideTriggerSuggestionMutation,
}));

const TriggerSuggestionsPanel = TriggerSuggestionsPanelModuleExport;

const workspaceId = 'ws-1';

function makeSuggestionFixture(
  overrides: Partial<TriggerTemplateSuggestionSummary> = {},
): TriggerTemplateSuggestionSummary {
  return {
    id: 'suggestion-1',
    workspaceId,
    name: 'Haftalık rapor hatırlatıcısı',
    kind: 'scheduled',
    spec: {
      kind: 'scheduled',
      intervalMinutes: 10080,
      actionTemplate: { title: 'Haftalık rapor gönder' },
    },
    rationale: 'Bu görev her hafta tekrarlanıyor, otomatikleştirmeyi düşünün',
    status: 'pending',
    createdTriggerId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

function mockQuery(
  data: { suggestions: TriggerTemplateSuggestionSummary[] } | undefined,
  overrides: Partial<UseQueryResult<{ suggestions: TriggerTemplateSuggestionSummary[] }>> = {},
): void {
  mockedUseTriggerSuggestionsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockAnalyzeMutation(
  overrides: Partial<
    UseMutationResult<{ suggestions: TriggerTemplateSuggestionSummary[] }, Error, void>
  > = {},
): { analyzeMutate: ReturnType<typeof vi.fn> } {
  const analyzeMutate = vi.fn();
  mockedUseRunTriggerSuggestionsAnalysisMutation.mockReturnValue({
    mutate: analyzeMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
    ...overrides,
  });
  return { analyzeMutate };
}

function mockDecideMutation(): { decideMutate: ReturnType<typeof vi.fn> } {
  const decideMutate = vi.fn();
  mockedUseDecideTriggerSuggestionMutation.mockReturnValue({
    mutate: decideMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  });
  return { decideMutate };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TriggerSuggestionsPanel', () => {
  it('renders a loading state (data-testid="trigger-suggestions-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestions-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="trigger-suggestions-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestions-error')).toBeInTheDocument();
  });

  it('renders the "Şimdi analiz et" button once loaded, even with zero pending suggestions', () => {
    mockQuery({ suggestions: [] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestions-analyze-button')).toBeInTheDocument();
  });

  it("clicking the analyze button calls the analyze mutation's mutate with no arguments", async () => {
    mockQuery({ suggestions: [] });
    const { analyzeMutate } = mockAnalyzeMutation();
    mockDecideMutation();
    const user = userEvent.setup();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('trigger-suggestions-analyze-button'));

    expect(analyzeMutate).toHaveBeenCalledTimes(1);
    expect(analyzeMutate).toHaveBeenCalledWith();
  });

  it('disables the analyze button while the analyze mutation isPending', () => {
    mockQuery({ suggestions: [] });
    mockAnalyzeMutation({ isPending: true });
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestions-analyze-button')).toBeDisabled();
  });

  it('renders a visible analyze-error message (data-testid="trigger-suggestions-analyze-error") without hiding the rest of the panel when the analyze mutation isError', () => {
    const suggestion = makeSuggestionFixture();
    mockQuery({ suggestions: [suggestion] });
    mockAnalyzeMutation({ isError: true, error: new Error('cooldown active') });
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestions-analyze-error')).toBeInTheDocument();
    expect(screen.getByTestId('trigger-suggestion-item-suggestion-1')).toBeInTheDocument();
    expect(screen.getByTestId('trigger-suggestions-analyze-button')).toBeInTheDocument();
  });

  it('renders a pending-empty state (data-testid="trigger-suggestions-pending-empty") when there are zero pending suggestions', () => {
    const decided = makeSuggestionFixture({
      id: 'suggestion-decided-1',
      status: 'approved',
      decidedAt: '2026-08-02T00:00:00.000Z',
      createdTriggerId: 'trigger-1',
    });
    mockQuery({ suggestions: [decided] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestions-pending-empty')).toBeInTheDocument();
  });

  it('renders a pending suggestion showing both its name and its rationale', () => {
    const suggestion = makeSuggestionFixture({
      id: 'suggestion-1',
      name: 'Haftalık rapor hatırlatıcısı',
      rationale: 'Bu görev her hafta tekrarlanıyor, otomatikleştirmeyi düşünün',
    });
    mockQuery({ suggestions: [suggestion] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('trigger-suggestion-item-suggestion-1');
    expect(row).toHaveTextContent('Haftalık rapor hatırlatıcısı');
    expect(row).toHaveTextContent('Bu görev her hafta tekrarlanıyor, otomatikleştirmeyi düşünün');
    expect(screen.getByTestId('trigger-suggestion-approve-suggestion-1')).toBeInTheDocument();
    expect(screen.getByTestId('trigger-suggestion-reject-suggestion-1')).toBeInTheDocument();
  });

  it('renders one row per pending suggestion for a multi-suggestion dataset', () => {
    const first = makeSuggestionFixture({ id: 'suggestion-1', name: 'Öneri Bir' });
    const second = makeSuggestionFixture({ id: 'suggestion-2', name: 'Öneri İki' });
    mockQuery({ suggestions: [first, second] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestion-item-suggestion-1')).toHaveTextContent(
      'Öneri Bir',
    );
    expect(screen.getByTestId('trigger-suggestion-item-suggestion-2')).toHaveTextContent(
      'Öneri İki',
    );
  });

  it('clicking approve on a pending suggestion calls the decide mutation with { suggestionId, decision: "approve" }', async () => {
    const suggestion = makeSuggestionFixture({ id: 'suggestion-1' });
    mockQuery({ suggestions: [suggestion] });
    mockAnalyzeMutation();
    const { decideMutate } = mockDecideMutation();
    const user = userEvent.setup();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('trigger-suggestion-approve-suggestion-1'));

    expect(decideMutate).toHaveBeenCalledTimes(1);
    expect(decideMutate).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      decision: 'approve',
    });
  });

  it('clicking reject on a pending suggestion calls the decide mutation with { suggestionId, decision: "reject" }', async () => {
    const suggestion = makeSuggestionFixture({ id: 'suggestion-1' });
    mockQuery({ suggestions: [suggestion] });
    mockAnalyzeMutation();
    const { decideMutate } = mockDecideMutation();
    const user = userEvent.setup();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('trigger-suggestion-reject-suggestion-1'));

    expect(decideMutate).toHaveBeenCalledTimes(1);
    expect(decideMutate).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      decision: 'reject',
    });
  });

  it('renders a decided section (data-testid="trigger-suggestion-decided-section") with one row per non-pending suggestion', () => {
    const decided = makeSuggestionFixture({
      id: 'suggestion-decided-1',
      status: 'approved',
      decidedAt: '2026-08-02T00:00:00.000Z',
      createdTriggerId: 'trigger-1',
    });
    mockQuery({ suggestions: [decided] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    const decidedSection = screen.getByTestId('trigger-suggestion-decided-section');
    expect(decidedSection).toBeInTheDocument();
    expect(
      within(decidedSection).getByTestId('trigger-suggestion-decided-item-suggestion-decided-1'),
    ).toBeInTheDocument();
  });

  it('a decided suggestion row has NO approve/reject buttons anywhere inside it (read-only)', () => {
    const decided = makeSuggestionFixture({
      id: 'suggestion-decided-1',
      status: 'rejected',
      decidedAt: '2026-08-02T00:00:00.000Z',
    });
    mockQuery({ suggestions: [decided] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    const decidedRow = screen.getByTestId('trigger-suggestion-decided-item-suggestion-decided-1');
    expect(
      within(decidedRow).queryByTestId('trigger-suggestion-approve-suggestion-decided-1'),
    ).not.toBeInTheDocument();
    expect(
      within(decidedRow).queryByTestId('trigger-suggestion-reject-suggestion-decided-1'),
    ).not.toBeInTheDocument();
  });

  it('a decided (approved) suggestion row shows the "approved" status text', () => {
    const decided = makeSuggestionFixture({
      id: 'suggestion-decided-1',
      status: 'approved',
      decidedAt: '2026-08-02T00:00:00.000Z',
      createdTriggerId: 'trigger-1',
    });
    mockQuery({ suggestions: [decided] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    const decidedRow = screen.getByTestId('trigger-suggestion-decided-item-suggestion-decided-1');
    expect(decidedRow.textContent).toMatch(/approved|onaylandı|Onaylandı/);
  });

  it('a decided (rejected) suggestion row shows the "rejected" status text', () => {
    const decided = makeSuggestionFixture({
      id: 'suggestion-decided-2',
      status: 'rejected',
      decidedAt: '2026-08-02T00:00:00.000Z',
    });
    mockQuery({ suggestions: [decided] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    const decidedRow = screen.getByTestId('trigger-suggestion-decided-item-suggestion-decided-2');
    expect(decidedRow.textContent).toMatch(/rejected|reddedildi|Reddedildi/);
  });

  it('renders both a pending suggestion and a decided suggestion simultaneously (mixed dataset)', () => {
    const pending = makeSuggestionFixture({ id: 'suggestion-pending-1', status: 'pending' });
    const decided = makeSuggestionFixture({
      id: 'suggestion-decided-1',
      status: 'approved',
      decidedAt: '2026-08-02T00:00:00.000Z',
      createdTriggerId: 'trigger-1',
    });
    mockQuery({ suggestions: [pending, decided] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('trigger-suggestion-item-suggestion-pending-1')).toBeInTheDocument();
    expect(
      screen.getByTestId('trigger-suggestion-decided-item-suggestion-decided-1'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('trigger-suggestions-pending-empty')).not.toBeInTheDocument();
  });

  it('sources identity only from the workspaceId prop -- every hook is called with exactly that value', () => {
    mockQuery({ suggestions: [] });
    mockAnalyzeMutation();
    mockDecideMutation();

    render(<TriggerSuggestionsPanel workspaceId={workspaceId} />);

    expect(mockedUseTriggerSuggestionsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseRunTriggerSuggestionsAnalysisMutation).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseDecideTriggerSuggestionMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [
      mockedUseTriggerSuggestionsQuery,
      mockedUseRunTriggerSuggestionsAnalysisMutation,
      mockedUseDecideTriggerSuggestionMutation,
    ]) {
      for (const call of mockedHook.mock.calls as unknown[][]) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});
