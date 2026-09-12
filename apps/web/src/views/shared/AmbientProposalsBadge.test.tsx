import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmbientProposalsBadge } from './AmbientProposalsBadge.js';
import { AMBIENT_BADGE_SAMPLE_LIMIT } from '../../hooks/useAmbientPendingProposalsQuery.js';

/**
 * F3-T9 PR2 (ADR-0043 Karar e, spec `docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md`
 * Kabul Kriterleri) — TDD red step. NEITHER
 * `apps/web/src/views/shared/AmbientProposalsBadge.tsx` NOR
 * `apps/web/src/hooks/useAmbientPendingProposalsQuery.ts` exist yet —
 * implementer must build:
 *
 *   export function AmbientProposalsBadge({ workspaceId }: { workspaceId: string }): JSX.Element | null;
 *       // renders NULL (nothing) while data?.count is 0 or undefined -- the
 *       // whole point of "ambient": silent when there's nothing to show
 *       // (ADR-0043 Karar e's own code sketch).
 *       // when count > 0: an <a href="#automation-history-panel"
 *       // data-testid="ambient-proposals-badge"> containing:
 *       //   - `${count} bekleyen öneri` when hasMore is false
 *       //   - `${AMBIENT_BADGE_SAMPLE_LIMIT}+ bekleyen öneri` when hasMore is true
 *       // (ADR-0043 Karar e's own code sketch, verbatim Turkish wording).
 *
 * `useAmbientPendingProposalsQuery` (../../hooks/useAmbientPendingProposalsQuery.js)
 * doesn't exist yet, so — mirroring this suite's own established
 * `vi.hoisted`+`vi.mock` technique for not-yet-existing hook modules
 * (CommandPalette.test.tsx's `useInviteMeetingBotMutation`/
 * `useExternalSearchQuery`) — the mock is created via `vi.hoisted` and
 * referenced only by closure inside the `vi.mock` factory below. The mock
 * factory ALSO exports `AMBIENT_BADGE_SAMPLE_LIMIT: 5` (ADR-0043 Karar e's
 * pinned value) so this test file's own import of that constant (used to
 * build the expected "5+ ..." text) resolves against the SAME mocked value
 * the component itself will read, keeping the two in lockstep rather than
 * hardcoding the literal `5` twice.
 */

const { mockedUseAmbientPendingProposalsQuery } = vi.hoisted(() => {
  return { mockedUseAmbientPendingProposalsQuery: vi.fn() };
});

vi.mock('../../hooks/useAmbientPendingProposalsQuery.js', () => ({
  useAmbientPendingProposalsQuery: mockedUseAmbientPendingProposalsQuery,
  AMBIENT_BADGE_SAMPLE_LIMIT: 5,
}));

function mockQuery(data: { count: number; hasMore: boolean } | undefined): void {
  mockedUseAmbientPendingProposalsQuery.mockReturnValue({
    data,
    isLoading: data === undefined,
    isError: false,
    error: null,
  });
}

const WORKSPACE_ID = 'ws-1';

afterEach(() => {
  vi.clearAllMocks();
});

describe('AmbientProposalsBadge', () => {
  it('renders nothing when count is 0 (ambient -- silent when there is nothing to show)', () => {
    mockQuery({ count: 0, hasMore: false });

    const { container } = render(<AmbientProposalsBadge workspaceId={WORKSPACE_ID} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while the query has not resolved yet (data undefined)', () => {
    mockQuery(undefined);

    const { container } = render(<AmbientProposalsBadge workspaceId={WORKSPACE_ID} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders a link to #automation-history-panel with the exact count when count > 0 and hasMore is false', () => {
    mockQuery({ count: 2, hasMore: false });

    render(<AmbientProposalsBadge workspaceId={WORKSPACE_ID} />);

    const badge = screen.getByTestId('ambient-proposals-badge');
    expect(badge).toHaveAttribute('href', '#automation-history-panel');
    expect(badge).toHaveTextContent('2 bekleyen öneri');
  });

  it('renders the "N+ bekleyen öneri" wording (N = AMBIENT_BADGE_SAMPLE_LIMIT) when hasMore is true, regardless of the exact count', () => {
    mockQuery({ count: AMBIENT_BADGE_SAMPLE_LIMIT, hasMore: true });

    render(<AmbientProposalsBadge workspaceId={WORKSPACE_ID} />);

    const badge = screen.getByTestId('ambient-proposals-badge');
    expect(badge).toHaveTextContent(`${String(AMBIENT_BADGE_SAMPLE_LIMIT)}+ bekleyen öneri`);
  });

  it('reads the query hooked for exactly the given workspaceId', () => {
    mockQuery({ count: 1, hasMore: false });

    render(<AmbientProposalsBadge workspaceId={WORKSPACE_ID} />);

    expect(mockedUseAmbientPendingProposalsQuery).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
