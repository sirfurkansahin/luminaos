import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FederationAuditLogPanel as FederationAuditLogPanelModuleExport } from './FederationAuditLogPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T14 PR3 (ADR-0048 §h/RBAC özeti "member+", spec Kabul Kriterleri:
 * "Denetim günlüğü paneli her iki event tipini ayırt ederek doğru render
 * ediyor") — TDD red step. Contract under test (not yet implemented —
 * implementer must build
 * apps/web/src/views/shared/FederationAuditLogPanel.tsx to satisfy these
 * tests):
 *
 *   export interface FederationAuditLogPanelProps { workspaceId: string; linkId: string; }
 *   export function FederationAuditLogPanel(props: FederationAuditLogPanelProps): React.JSX.Element;
 *
 * Deliberately has NO `isAdmin`/RBAC prop at all (unlike
 * `FederationLinksPanel`) — reading one's own workspace's federation audit
 * log is `member+` (ADR-0016 §a: read paths are never role-gated beyond
 * plain membership), enforced server-side only; this component is rendered
 * identically for every workspace member.
 *
 * Uses `useFederationAuditLogQuery` (../../hooks/useFederationAuditLogQuery.js),
 * mocked wholesale below via `vi.hoisted` (mirrors
 * `AutonomyTierPanel.test.tsx`'s established approach) — that hook module is
 * never imported directly by this file.
 *
 * Contract pinned:
 * - top-level states: isLoading -> data-testid="federation-audit-log-loading";
 *   isError -> data-testid="federation-audit-log-error"; zero events ->
 *   data-testid="federation-audit-log-empty".
 * - otherwise, one row per event, data-testid=`federation-audit-log-item-${event.id}`.
 * - each row's rendered content DISTINGUISHES the two possible `event.type`
 *   values distinctly and visibly: a `FederatedContextAccessed` row carries
 *   data-testid=`federation-audit-log-type-accessed-${event.id}`; a
 *   `FederatedContextRequested` row carries
 *   data-testid=`federation-audit-log-type-requested-${event.id}` — a given
 *   row NEVER carries both testids at once, and the two types' rendered text
 *   must differ (not just their testid).
 * - `useFederationAuditLogQuery` is called with exactly `(workspaceId, linkId)`.
 */

interface FederationAuditEvent {
  id: string;
  streamId: string;
  streamType: string;
  workspaceId: string;
  type: 'FederatedContextAccessed' | 'FederatedContextRequested';
  version: number;
  payload: Record<string, unknown>;
  actor: { type: string; id: string };
  occurredAt: string;
  globalPosition: number;
}

const { mockedUseFederationAuditLogQuery } = vi.hoisted(() => {
  return { mockedUseFederationAuditLogQuery: vi.fn() };
});

vi.mock('../../hooks/useFederationAuditLogQuery.js', () => ({
  useFederationAuditLogQuery: mockedUseFederationAuditLogQuery,
}));

// `./FederationAuditLogPanel.tsx` does not exist yet -- see
// `useFederationLinksQuery.test.ts`'s header comment for the
// `ModuleExport as unknown as <shape>` lint-avoidance rationale.
const FederationAuditLogPanel = FederationAuditLogPanelModuleExport;

const workspaceId = 'ws-1';
const linkId = 'link-1';

function makeAccessedEventFixture(
  overrides: Partial<FederationAuditEvent> = {},
): FederationAuditEvent {
  return {
    id: 'event-1',
    streamId: 'stream-1',
    streamType: 'federation-audit',
    workspaceId: 'ws-1',
    type: 'FederatedContextAccessed',
    version: 1,
    payload: {
      linkId: 'link-1',
      credentialId: 'cred-1',
      granteeWorkspaceId: 'ws-2',
      objectId: 'obj-1',
      occurredAt: '2026-09-01T00:00:00.000Z',
    },
    actor: { type: 'system', id: 'federation-audit-service' },
    occurredAt: '2026-09-01T00:00:00.000Z',
    globalPosition: 1,
    ...overrides,
  };
}

function makeRequestedEventFixture(
  overrides: Partial<FederationAuditEvent> = {},
): FederationAuditEvent {
  return makeAccessedEventFixture({
    id: 'event-2',
    type: 'FederatedContextRequested',
    workspaceId: 'ws-2',
    payload: {
      linkId: 'link-1',
      credentialId: 'cred-1',
      hostWorkspaceId: 'ws-1',
      objectId: 'obj-1',
      occurredAt: '2026-09-01T00:05:00.000Z',
    },
    ...overrides,
  });
}

function mockAuditLogQuery(
  data: { events: FederationAuditEvent[] } | undefined,
  overrides: Partial<UseQueryResult<{ events: FederationAuditEvent[] }>> = {},
): void {
  mockedUseFederationAuditLogQuery.mockReturnValue({
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

describe('FederationAuditLogPanel', () => {
  it('renders a loading state (data-testid="federation-audit-log-loading") while the query is loading', () => {
    mockAuditLogQuery(undefined, { isLoading: true });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    expect(screen.getByTestId('federation-audit-log-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="federation-audit-log-error") when the query isError', () => {
    mockAuditLogQuery(undefined, { isError: true, error: new Error('boom') });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    expect(screen.getByTestId('federation-audit-log-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="federation-audit-log-empty") when there are zero events', () => {
    mockAuditLogQuery({ events: [] });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    expect(screen.getByTestId('federation-audit-log-empty')).toBeInTheDocument();
  });

  it('renders a FederatedContextAccessed event distinctly from a FederatedContextRequested event, both present at once', () => {
    const accessedEvent = makeAccessedEventFixture();
    const requestedEvent = makeRequestedEventFixture();
    mockAuditLogQuery({ events: [accessedEvent, requestedEvent] });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    const accessedTestId = screen.getByTestId('federation-audit-log-type-accessed-event-1');
    const requestedTestId = screen.getByTestId('federation-audit-log-type-requested-event-2');
    expect(accessedTestId).toBeInTheDocument();
    expect(requestedTestId).toBeInTheDocument();
    expect(accessedTestId.textContent).not.toEqual(requestedTestId.textContent);
  });

  it('never renders both the accessed and requested testid on the same event row', () => {
    const accessedEvent = makeAccessedEventFixture();
    mockAuditLogQuery({ events: [accessedEvent] });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    expect(screen.getByTestId('federation-audit-log-item-event-1')).toBeInTheDocument();
    expect(screen.getByTestId('federation-audit-log-type-accessed-event-1')).toBeInTheDocument();
    expect(
      screen.queryByTestId('federation-audit-log-type-requested-event-1'),
    ).not.toBeInTheDocument();
  });

  it('one row per event, data-testid=`federation-audit-log-item-${event.id}`', () => {
    const accessedEvent = makeAccessedEventFixture({ id: 'event-a' });
    const requestedEvent = makeRequestedEventFixture({ id: 'event-b' });
    mockAuditLogQuery({ events: [accessedEvent, requestedEvent] });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    expect(screen.getByTestId('federation-audit-log-item-event-a')).toBeInTheDocument();
    expect(screen.getByTestId('federation-audit-log-item-event-b')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^federation-audit-log-item-/)).toHaveLength(2);
  });

  it('calls useFederationAuditLogQuery with exactly (workspaceId, linkId) -- no RBAC/isAdmin prop consulted', () => {
    mockAuditLogQuery({ events: [] });

    render(<FederationAuditLogPanel workspaceId={workspaceId} linkId={linkId} />);

    expect(mockedUseFederationAuditLogQuery).toHaveBeenCalledWith(workspaceId, linkId);
  });
});
