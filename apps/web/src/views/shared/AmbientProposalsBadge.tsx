import {
  AMBIENT_BADGE_SAMPLE_LIMIT,
  useAmbientPendingProposalsQuery,
} from '../../hooks/useAmbientPendingProposalsQuery.js';

/**
 * F3-T9 PR2 (ADR-0043 Karar e) -- minimal, passive ambient badge surfacing
 * ALREADY-EXISTING pending command proposals (ZERO new AI-triggering
 * mechanism, human decision 1). Silent when there is nothing pending; links
 * to `AutomationHistoryPanel`'s anchor for the actual approve/reject UI.
 */
export function AmbientProposalsBadge({ workspaceId }: { workspaceId: string }) {
  const { data } = useAmbientPendingProposalsQuery(workspaceId);
  const count = data?.count ?? 0;

  if (count === 0) {
    return null;
  }

  return (
    <a href="#automation-history-panel" data-testid="ambient-proposals-badge">
      {data?.hasMore === true
        ? `${String(AMBIENT_BADGE_SAMPLE_LIMIT)}+ bekleyen öneri`
        : `${String(count)} bekleyen öneri`}
    </a>
  );
}
