import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationHistoryPanel as AutomationHistoryPanelModuleExport } from './AutomationHistoryPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T16 PR4 (ADR-0033 §h, spec Kabul Kriterleri: "apps/web'de F1-T16'dan
 * beri hiç var olmamış onay/red arayüzü") — TDD red step. Contract under test
 * (not yet implemented — implementer must build
 * apps/web/src/views/shared/AutomationHistoryPanel.tsx to satisfy these
 * tests):
 *
 *   export interface AutomationHistoryPanelProps { workspaceId: string; }
 *   export function AutomationHistoryPanel(props: AutomationHistoryPanelProps): React.JSX.Element;
 *
 * This is a NEW UI shape (no direct 1:1 template). Combines
 * `IntegrationsPanel.tsx`'s plain-list-no-dialog convention (no dialog at
 * all here) with real Approve/Reject buttons wired to the decide mutation.
 * The panel calls `useProposalsQuery(workspaceId)` ONCE with NO filter, then
 * splits `data.proposals` CLIENT-SIDE by `decidedAt === null` (pending) vs
 * `decidedAt !== null` (decided).
 *
 * Contract pinned:
 * - top-level states: isLoading -> data-testid="automation-history-loading";
 *   isError -> data-testid="automation-history-error"; zero PENDING
 *   proposals -> data-testid="automation-history-pending-empty" (decided
 *   section still renders independently of this).
 * - each PENDING proposal -> data-testid=`proposal-item-${proposal.id}`,
 *   text content includes `proposal.command`; one row per action ->
 *   data-testid=`proposal-action-${action.actionId}` showing `action.intent`,
 *   with two buttons data-testid=`proposal-action-approve-${action.actionId}`
 *   / `proposal-action-reject-${action.actionId}`.
 * - clicking approve/reject on a specific action calls the decide mutation's
 *   `mutate` with EXACTLY
 *   `{ proposalId: proposal.id, decisions: [{ actionId, decision }] }` — a
 *   SINGLE-action decision per click, never a batch of the whole proposal.
 * - a DECIDED section -> data-testid="proposal-decided-section" containing
 *   one row per decided proposal -> data-testid=
 *   `proposal-decided-item-${proposal.id}` (read-only, NO approve/reject
 *   buttons anywhere inside), each action's outcome status (from
 *   `proposal.decisions`, matched by actionId) rendered somewhere in that
 *   row's text content.
 * - every hook called with exactly `workspaceId`.
 *
 * NOTE on the "partial decision, still pending" edge case from the task
 * brief: per `apps/server/src/commands/commands.service.ts`'s `decide()`
 * (throws ConflictError if `row.decidedAt !== null` BEFORE looking at which
 * actionIds are in the current call) and
 * `apps/server/src/commands/action-proposal.projection.ts`'s
 * `ActionsDecided` handler (unconditionally sets `decidedAt` on the WHOLE
 * proposal row for ANY successful decide() call, regardless of how many of
 * the proposal's actionIds were included in `decisions`), a proposal can be
 * decide()-d AT MOST ONCE, ever — there is no reachable state where SOME of
 * a proposal's actions have already been decided while the proposal itself
 * remains pending (`decidedAt === null`). The very first successful decide()
 * call, no matter how many actionIds it carries, immediately and
 * permanently moves the whole proposal to "decided". So the
 * "partial-decision-then-still-pending" test from the task brief is SKIPPED
 * here as testing an unreachable backend state — see this comment as its
 * placeholder/rationale.
 *
 * `useProposalsQuery`/`useDecideProposalMutation`
 * (../../hooks/useProposalsQuery.ts) do not exist yet, so — mirroring
 * McpAccessPanel.test.tsx's handling of the equally-not-yet-existing
 * useMcpGrantsQuery hooks — mock functions are created via `vi.hoisted` and
 * referenced ONLY by closure inside the `vi.mock` factory below; this file
 * never imports that hook module itself. The `CommandProposalSummary`/
 * `ProposedActionSummary`/`DecideActionResult` shapes are declared locally
 * for the same reason. `./AutomationHistoryPanel.tsx` itself DOES NOT exist
 * yet either — imported directly (`ModuleExport` cast), so this test file is
 * expected to fail to even resolve that import until the component exists —
 * the documented TDD red state.
 */

interface ProposedActionSummary {
  actionId: string;
  type: string;
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}

interface DecideActionResult {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
  createdCount?: number;
  totalCount?: number;
  failedAtStep?: number;
  error?: string;
}

interface CommandProposalSummary {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: ProposedActionSummary[];
  decisions: DecideActionResult[] | null;
  createdAt: string;
  decidedAt: string | null;
}

const { mockedUseProposalsQuery, mockedUseDecideProposalMutation } = vi.hoisted(() => {
  return {
    mockedUseProposalsQuery: vi.fn(),
    mockedUseDecideProposalMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useProposalsQuery.js', () => ({
  useProposalsQuery: mockedUseProposalsQuery,
  useDecideProposalMutation: mockedUseDecideProposalMutation,
}));

const AutomationHistoryPanel = AutomationHistoryPanelModuleExport;

const workspaceId = 'ws-1';

function makeActionFixture(overrides: Partial<ProposedActionSummary> = {}): ProposedActionSummary {
  return {
    actionId: 'action-1',
    type: 'createTask',
    intent: "Ayşe için 'Rapor gönder' görevi oluştur",
    rationale: 'Toplantıda bahsedildi',
    resources: [],
    rollbackNote: 'Görev silinebilir',
    params: {},
    ...overrides,
  };
}

function makeProposalFixture(
  overrides: Partial<CommandProposalSummary> = {},
): CommandProposalSummary {
  return {
    id: 'proposal-1',
    workspaceId,
    command: 'Toplantıdan sonra Ayşe için bir görev oluştur',
    sourceObjectId: 'meeting-1',
    actions: [makeActionFixture()],
    decisions: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

function mockQuery(
  data: { proposals: CommandProposalSummary[]; nextCursor?: string } | undefined,
  overrides: Partial<
    UseQueryResult<{ proposals: CommandProposalSummary[]; nextCursor?: string }>
  > = {},
): void {
  mockedUseProposalsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockDecideMutation(): { decideMutate: ReturnType<typeof vi.fn> } {
  const decideMutate = vi.fn();
  mockedUseDecideProposalMutation.mockReturnValue({
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

describe('AutomationHistoryPanel', () => {
  it('renders a loading state (data-testid="automation-history-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('automation-history-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="automation-history-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('automation-history-error')).toBeInTheDocument();
  });

  it('renders a pending-empty state (data-testid="automation-history-pending-empty") when there are zero pending proposals', () => {
    const decided = makeProposalFixture({
      id: 'proposal-decided-1',
      decidedAt: '2026-08-02T00:00:00.000Z',
      decisions: [{ actionId: 'action-1', status: 'executed', createdCount: 1, totalCount: 1 }],
    });
    mockQuery({ proposals: [decided] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('automation-history-pending-empty')).toBeInTheDocument();
  });

  it('renders a pending proposal showing its command text and one row per action', () => {
    const proposal = makeProposalFixture({
      id: 'proposal-1',
      command: 'Toplantıdan sonra Ayşe için bir görev oluştur',
      actions: [makeActionFixture({ actionId: 'action-1', intent: "'Rapor gönder' görevi" })],
    });
    mockQuery({ proposals: [proposal] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    const proposalRow = screen.getByTestId('proposal-item-proposal-1');
    expect(proposalRow).toHaveTextContent('Toplantıdan sonra Ayşe için bir görev oluştur');

    const actionRow = screen.getByTestId('proposal-action-action-1');
    expect(actionRow).toHaveTextContent("'Rapor gönder' görevi");
    expect(screen.getByTestId('proposal-action-approve-action-1')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-action-reject-action-1')).toBeInTheDocument();
  });

  it('renders one action row per action for a multi-action pending proposal', () => {
    const proposal = makeProposalFixture({
      id: 'proposal-1',
      actions: [
        makeActionFixture({ actionId: 'action-1' }),
        makeActionFixture({ actionId: 'action-2', intent: 'İkinci aksiyon' }),
      ],
    });
    mockQuery({ proposals: [proposal] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('proposal-action-action-1')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-action-action-2')).toHaveTextContent('İkinci aksiyon');
  });

  it('clicking approve on a specific action calls the decide mutation with a SINGLE-action approved decision', async () => {
    const proposal = makeProposalFixture({
      id: 'proposal-1',
      actions: [makeActionFixture({ actionId: 'action-1' })],
    });
    mockQuery({ proposals: [proposal] });
    const { decideMutate } = mockDecideMutation();
    const user = userEvent.setup();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('proposal-action-approve-action-1'));

    expect(decideMutate).toHaveBeenCalledTimes(1);
    expect(decideMutate).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      decisions: [{ actionId: 'action-1', decision: 'approved' }],
    });
  });

  it('clicking reject on a specific action calls the decide mutation with a SINGLE-action rejected decision', async () => {
    const proposal = makeProposalFixture({
      id: 'proposal-1',
      actions: [makeActionFixture({ actionId: 'action-1' })],
    });
    mockQuery({ proposals: [proposal] });
    const { decideMutate } = mockDecideMutation();
    const user = userEvent.setup();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('proposal-action-reject-action-1'));

    expect(decideMutate).toHaveBeenCalledTimes(1);
    expect(decideMutate).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      decisions: [{ actionId: 'action-1', decision: 'rejected' }],
    });
  });

  it('clicking approve on one action of a MULTI-action proposal only decides that single actionId, not the whole proposal', async () => {
    const proposal = makeProposalFixture({
      id: 'proposal-1',
      actions: [
        makeActionFixture({ actionId: 'action-1' }),
        makeActionFixture({ actionId: 'action-2' }),
      ],
    });
    mockQuery({ proposals: [proposal] });
    const { decideMutate } = mockDecideMutation();
    const user = userEvent.setup();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('proposal-action-approve-action-2'));

    expect(decideMutate).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      decisions: [{ actionId: 'action-2', decision: 'approved' }],
    });
  });

  it('renders a decided section (data-testid="proposal-decided-section") with one row per decided proposal', () => {
    const decided = makeProposalFixture({
      id: 'proposal-decided-1',
      decidedAt: '2026-08-02T00:00:00.000Z',
      decisions: [{ actionId: 'action-1', status: 'executed', createdCount: 1, totalCount: 1 }],
    });
    mockQuery({ proposals: [decided] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    const decidedSection = screen.getByTestId('proposal-decided-section');
    expect(decidedSection).toBeInTheDocument();
    expect(
      within(decidedSection).getByTestId('proposal-decided-item-proposal-decided-1'),
    ).toBeInTheDocument();
  });

  it('a decided proposal row has NO approve/reject buttons anywhere inside it (read-only)', () => {
    const decided = makeProposalFixture({
      id: 'proposal-decided-1',
      decidedAt: '2026-08-02T00:00:00.000Z',
      actions: [makeActionFixture({ actionId: 'action-1' })],
      decisions: [{ actionId: 'action-1', status: 'executed', createdCount: 1, totalCount: 1 }],
    });
    mockQuery({ proposals: [decided] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    const decidedRow = screen.getByTestId('proposal-decided-item-proposal-decided-1');
    expect(
      within(decidedRow).queryByTestId('proposal-action-approve-action-1'),
    ).not.toBeInTheDocument();
    expect(
      within(decidedRow).queryByTestId('proposal-action-reject-action-1'),
    ).not.toBeInTheDocument();
  });

  it('a decided proposal row shows each action\'s outcome status text (e.g. "executed")', () => {
    const decided = makeProposalFixture({
      id: 'proposal-decided-1',
      decidedAt: '2026-08-02T00:00:00.000Z',
      actions: [makeActionFixture({ actionId: 'action-1' })],
      decisions: [{ actionId: 'action-1', status: 'executed', createdCount: 1, totalCount: 1 }],
    });
    mockQuery({ proposals: [decided] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    const decidedRow = screen.getByTestId('proposal-decided-item-proposal-decided-1');
    expect(decidedRow.textContent).toMatch(/executed|çalıştırıldı|Çalıştırıldı/);
  });

  it('a decided proposal row shows the "rejected" outcome status for a rejected action', () => {
    const decided = makeProposalFixture({
      id: 'proposal-decided-2',
      decidedAt: '2026-08-02T00:00:00.000Z',
      actions: [makeActionFixture({ actionId: 'action-1' })],
      decisions: [{ actionId: 'action-1', status: 'rejected' }],
    });
    mockQuery({ proposals: [decided] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    const decidedRow = screen.getByTestId('proposal-decided-item-proposal-decided-2');
    expect(decidedRow.textContent).toMatch(/rejected|reddedildi|Reddedildi/);
  });

  it('renders both a pending proposal and a decided proposal simultaneously (mixed dataset)', () => {
    const pending = makeProposalFixture({ id: 'proposal-pending-1', decidedAt: null });
    const decided = makeProposalFixture({
      id: 'proposal-decided-1',
      decidedAt: '2026-08-02T00:00:00.000Z',
      decisions: [{ actionId: 'action-1', status: 'executed', createdCount: 1, totalCount: 1 }],
    });
    mockQuery({ proposals: [pending, decided] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('proposal-item-proposal-pending-1')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-decided-item-proposal-decided-1')).toBeInTheDocument();
    expect(screen.queryByTestId('automation-history-pending-empty')).not.toBeInTheDocument();
  });

  it('sources identity only from the workspaceId prop -- every hook is called with exactly that value', () => {
    mockQuery({ proposals: [] });
    mockDecideMutation();

    render(<AutomationHistoryPanel workspaceId={workspaceId} />);

    expect(mockedUseProposalsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseDecideProposalMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [mockedUseProposalsQuery, mockedUseDecideProposalMutation]) {
      for (const call of mockedHook.mock.calls as unknown[][]) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});
