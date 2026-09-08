import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlightRecorderPanel as FlightRecorderPanelModuleExport } from './FlightRecorderPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T4 PR4 (ADR-0038 §h, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/FlightRecorderPanel.tsx to satisfy these tests):
 *
 *   export interface FlightRecorderPanelProps { workspaceId: string; }
 *   export function FlightRecorderPanel(props: FlightRecorderPanelProps): React.JSX.Element;
 *
 * This is a NEW, purely READ-ONLY panel — mirrors `AutomationHistoryPanel.tsx`'s
 * plain-list-no-dialog convention, but with NO pending/decided split and NO
 * approve/reject/edit/undo affordances anywhere (ADR-0038 §h/§g: this task
 * only records, F3-T6 will build any real undo UI later). Calls
 * `useAgentActionRecordsQuery(workspaceId)` ONCE, no filter, no mutation
 * counterpart.
 *
 * Contract pinned:
 * - top-level states: isLoading -> data-testid="flight-recorder-loading"
 *   (containing a Skeleton); isError -> data-testid="flight-recorder-error"
 *   (an EmptyState); data.records.length === 0 ->
 *   data-testid="flight-recorder-empty" (an EmptyState); otherwise ->
 *   data-testid="flight-recorder-list" containing one row per record.
 * - each row -> data-testid=`flight-recorder-item-${record.id}`, rendering
 *   somewhere in its text content: `intent`, `rationale`, `actionType`,
 *   `actor.id` (and some indication of `actor.type`), every entry in
 *   `resources[]` by its kind-specific identifying field (objectId /
 *   commentId / meetingId / agentIdentifier / label), and
 *   `rollbackPlan.description`.
 * - each row also carries a dedicated `data-testid=
 *   \`flight-recorder-occurred-${record.id}\`` element with SOME non-empty
 *   human-readable rendering of `occurredAt` (exact format is
 *   implementer's choice — not asserted precisely, matching
 *   McpAccessPanel.tsx's own precedent of not pinning locale-formatted date
 *   strings exactly).
 * - each row also carries a dedicated `data-testid=
 *   \`flight-recorder-outcome-${record.id}\`` element (the outcome Badge)
 *   whose text content identifies the outcome and whose rendered className
 *   differs between differently-mapped outcomes (succeeded -> 'success',
 *   partially_succeeded -> 'warning', failed -> 'danger', rejected ->
 *   'neutral' -- exact variant string not asserted directly since Badge's
 *   variant maps to a CSS Module class name, per Badge.test.tsx's own
 *   documented precedent of only asserting non-empty/distinct class names,
 *   not exact strings).
 * - ZERO buttons (or any other actionable/edit element) anywhere in the
 *   rendered panel, in ANY state that has records — this is the read-only
 *   guarantee that distinguishes this panel from AutomationHistoryPanel.tsx.
 * - the hook is called with exactly `workspaceId`.
 *
 * `useAgentActionRecordsQuery` (../../hooks/useAgentActionRecordsQuery.ts)
 * does not exist yet, so — mirroring AutomationHistoryPanel.test.tsx's
 * handling of the equally-not-yet-existing useProposalsQuery hooks at the
 * time of ITS red step — a mock function is created via `vi.hoisted` and
 * referenced ONLY by closure inside the `vi.mock` factory below; this file
 * never imports that hook module itself. The `AgentActionRecord`/etc. shapes
 * are declared locally for the same reason. `./FlightRecorderPanel.tsx`
 * itself DOES NOT exist yet either — imported directly (`ModuleExport`
 * cast), so this test file is expected to fail to even resolve that import
 * until the component exists — the documented TDD red state.
 */

type ActionProvenance = 'decided' | 'autonomous';
type AgentActionOutcome = 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';

type ActionResourceReference =
  | { kind: 'object'; objectId: string }
  | { kind: 'comment'; commentId: string }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'agent'; agentIdentifier: string }
  | { kind: 'external'; label: string };

interface RollbackPlan {
  kind: 'delete' | 'revertFieldValue' | 'revokePermission' | 'manual' | 'none';
  targetResource?: ActionResourceReference;
  description: string;
}

interface AgentActionRecord {
  id: string;
  workspaceId: string;
  provenance: ActionProvenance;
  actor: { type: 'user' | 'agent' | 'system'; id: string };
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: AgentActionOutcome;
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  occurredAt: string;
}

const { mockedUseAgentActionRecordsQuery } = vi.hoisted(() => {
  return { mockedUseAgentActionRecordsQuery: vi.fn() };
});

vi.mock('../../hooks/useAgentActionRecordsQuery.js', () => ({
  useAgentActionRecordsQuery: mockedUseAgentActionRecordsQuery,
}));

const FlightRecorderPanel = FlightRecorderPanelModuleExport;

const workspaceId = 'ws-1';

function makeRecordFixture(overrides: Partial<AgentActionRecord> = {}): AgentActionRecord {
  return {
    id: 'record-1',
    workspaceId,
    provenance: 'decided',
    actor: { type: 'user', id: 'user-1' },
    actionType: 'createTask',
    intent: "Ayşe için 'Rapor gönder' görevi oluştur",
    rationale: 'Toplantıda bahsedildi',
    resources: [{ kind: 'object', objectId: 'obj-1' }],
    rollbackPlan: {
      kind: 'delete',
      targetResource: { kind: 'object', objectId: 'obj-1' },
      description: 'Oluşturulan görevi sil.',
    },
    outcome: 'succeeded',
    resultRef: { kind: 'object', objectId: 'obj-1' },
    causationEventId: 'event-1',
    occurredAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAutonomousFailedFixture(): AgentActionRecord {
  return makeRecordFixture({
    id: 'record-2',
    provenance: 'autonomous',
    actor: { type: 'agent', id: 'report-bot@luminaos.internal' },
    actionType: 'answer-question',
    intent: "Bir yorumdaki @mention'a yanıt verildi",
    rationale:
      'Ajan, kendi izin manifestosu kapsamında bu nesnedeki bir mentiona otomatik yanıt verdi.',
    resources: [
      { kind: 'comment', commentId: 'comment-1' },
      { kind: 'object', objectId: 'obj-2' },
    ],
    rollbackPlan: { kind: 'none', description: 'Hiçbir mutasyon oluşmadı.' },
    outcome: 'failed',
    resultRef: null,
    causationEventId: null,
    occurredAt: '2026-08-02T00:00:00.000Z',
  });
}

function makeMixedResourcesFixture(): AgentActionRecord {
  return makeRecordFixture({
    id: 'record-3',
    provenance: 'decided',
    actionType: 'reconfigureAgentPermissions',
    resources: [
      { kind: 'meeting', meetingId: 'meeting-1' },
      { kind: 'agent', agentIdentifier: 'report-bot@luminaos.internal' },
      { kind: 'external', label: 'Slack #genel kanalı' },
    ],
    rollbackPlan: {
      kind: 'manual',
      description:
        'Önceki manifestoyu elle yeniden ver; bu defter revoke-öncesi durumu saklamıyor.',
    },
    outcome: 'partially_succeeded',
    resultRef: null,
    occurredAt: '2026-08-03T00:00:00.000Z',
  });
}

function makeRejectedFixture(): AgentActionRecord {
  return makeRecordFixture({
    id: 'record-4',
    resources: [],
    rollbackPlan: { kind: 'none', description: 'Hiçbir mutasyon oluşmadı.' },
    outcome: 'rejected',
    resultRef: null,
    occurredAt: '2026-08-04T00:00:00.000Z',
  });
}

function mockQuery(
  data: { records: AgentActionRecord[] } | undefined,
  overrides: Partial<UseQueryResult<{ records: AgentActionRecord[] }>> = {},
): void {
  mockedUseAgentActionRecordsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('FlightRecorderPanel', () => {
  it('renders a loading state (data-testid="flight-recorder-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('flight-recorder-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="flight-recorder-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('flight-recorder-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="flight-recorder-empty") when there are zero records', () => {
    mockQuery({ records: [] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('flight-recorder-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('flight-recorder-list')).not.toBeInTheDocument();
  });

  it('renders the list (data-testid="flight-recorder-list") with one row per record, no empty state', () => {
    const record = makeRecordFixture();
    mockQuery({ records: [record] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('flight-recorder-list')).toBeInTheDocument();
    expect(screen.getByTestId('flight-recorder-item-record-1')).toBeInTheDocument();
    expect(screen.queryByTestId('flight-recorder-empty')).not.toBeInTheDocument();
  });

  it('renders a decided+succeeded record row with intent/rationale/actionType/actor/resource/rollback fields', () => {
    const record = makeRecordFixture();
    mockQuery({ records: [record] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('flight-recorder-item-record-1');
    expect(row).toHaveTextContent(record.intent);
    expect(row).toHaveTextContent(record.rationale);
    expect(row).toHaveTextContent(record.actionType);
    expect(row).toHaveTextContent(record.actor.id);
    expect(row.textContent).toMatch(/user/i);
    expect(row).toHaveTextContent('obj-1');
    expect(row).toHaveTextContent(record.rollbackPlan.description);
  });

  it('renders an autonomous+failed record row with its own actor/resources/rollback distinct from a decided row', () => {
    const record = makeAutonomousFailedFixture();
    mockQuery({ records: [record] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('flight-recorder-item-record-2');
    expect(row).toHaveTextContent(record.intent);
    expect(row).toHaveTextContent(record.rationale);
    expect(row).toHaveTextContent(record.actionType);
    expect(row).toHaveTextContent('report-bot@luminaos.internal');
    expect(row.textContent).toMatch(/agent/i);
    expect(row).toHaveTextContent('comment-1');
    expect(row).toHaveTextContent('obj-2');
    expect(row).toHaveTextContent(record.rollbackPlan.description);
  });

  it('renders each kind-specific resource identifier for a record with meeting/agent/external resources', () => {
    const record = makeMixedResourcesFixture();
    mockQuery({ records: [record] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('flight-recorder-item-record-3');
    expect(row).toHaveTextContent('meeting-1');
    expect(row).toHaveTextContent('report-bot@luminaos.internal');
    expect(row).toHaveTextContent('Slack #genel kanalı');
  });

  it('renders a dedicated occurredAt element per row with a non-empty human-readable value', () => {
    const record = makeRecordFixture();
    mockQuery({ records: [record] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('flight-recorder-item-record-1');
    const occurredEl = within(row).getByTestId('flight-recorder-occurred-record-1');
    expect(occurredEl.textContent).not.toHaveLength(0);
  });

  it('renders a dedicated outcome badge element per row identifying the outcome', () => {
    const succeeded = makeRecordFixture({ id: 'record-succeeded', outcome: 'succeeded' });
    const partiallySucceeded = makeRecordFixture({
      id: 'record-partial',
      outcome: 'partially_succeeded',
    });
    const failed = makeRecordFixture({ id: 'record-failed', outcome: 'failed' });
    const rejected = makeRejectedFixture();
    mockQuery({ records: [succeeded, partiallySucceeded, failed, rejected] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('flight-recorder-outcome-record-succeeded').textContent).toMatch(
      /başarı|succeeded/i,
    );
    expect(screen.getByTestId('flight-recorder-outcome-record-partial').textContent).toMatch(
      /kısmen|partial/i,
    );
    expect(screen.getByTestId('flight-recorder-outcome-record-failed').textContent).toMatch(
      /başarısız|failed/i,
    );
    expect(screen.getByTestId('flight-recorder-outcome-record-4').textContent).toMatch(
      /reddedildi|rejected/i,
    );
  });

  it('maps different outcomes to visually distinct badge variants (distinct non-empty class names)', () => {
    const succeeded = makeRecordFixture({ id: 'record-succeeded', outcome: 'succeeded' });
    const failed = makeRecordFixture({ id: 'record-failed', outcome: 'failed' });
    mockQuery({ records: [succeeded, failed] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    const succeededBadge = screen.getByTestId('flight-recorder-outcome-record-succeeded');
    const failedBadge = screen.getByTestId('flight-recorder-outcome-record-failed');

    expect(succeededBadge.className).not.toBe('');
    expect(failedBadge.className).not.toBe('');
    expect(succeededBadge.className).not.toBe(failedBadge.className);
  });

  it('renders multiple records simultaneously (mixed provenance/outcome dataset)', () => {
    const decided = makeRecordFixture();
    const autonomous = makeAutonomousFailedFixture();
    mockQuery({ records: [decided, autonomous] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('flight-recorder-item-record-1')).toBeInTheDocument();
    expect(screen.getByTestId('flight-recorder-item-record-2')).toBeInTheDocument();
  });

  it('renders NO buttons or other actionable elements anywhere in the panel -- purely read-only', () => {
    const decided = makeRecordFixture();
    const autonomous = makeAutonomousFailedFixture();
    mockQuery({ records: [decided, autonomous] });

    const { container } = render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('sources identity only from the workspaceId prop -- the hook is called with exactly that value', () => {
    mockQuery({ records: [] });

    render(<FlightRecorderPanel workspaceId={workspaceId} />);

    expect(mockedUseAgentActionRecordsQuery).toHaveBeenCalledWith(workspaceId);
    for (const call of mockedUseAgentActionRecordsQuery.mock.calls as unknown[][]) {
      expect(call).toEqual([workspaceId]);
    }
  });
});
