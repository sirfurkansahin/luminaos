import { Button, EmptyState, Skeleton } from '@luminaos/ui';

import { useDecideProposalMutation, useProposalsQuery } from '../../hooks/useProposalsQuery.js';

import type { CommandProposalSummary, DecideActionResult } from '../../lib/apiClient.js';

/**
 * F2-T16 PR4 (ADR-0033 §g/§h) -- "Otomasyon Geçmişi" panel: real approve/
 * reject UI for AI-proposed command actions, plus a read-only decided
 * history. Combines `IntegrationsPanel.tsx`'s plain-list-no-dialog
 * convention with real Approve/Reject buttons wired to the decide mutation.
 * Calls `useProposalsQuery(workspaceId)` ONCE with no filter, splitting
 * `data.proposals` client-side by `decidedAt` into pending/decided.
 */
export interface AutomationHistoryPanelProps {
  workspaceId: string;
}

function decisionForAction(
  decisions: DecideActionResult[] | null,
  actionId: string,
): DecideActionResult | undefined {
  return decisions?.find((decision) => decision.actionId === actionId);
}

function PendingProposalRow({
  proposal,
  onDecide,
}: {
  proposal: CommandProposalSummary;
  onDecide: (proposalId: string, actionId: string, decision: 'approved' | 'rejected') => void;
}) {
  return (
    <li data-testid={`proposal-item-${proposal.id}`}>
      <p>{proposal.command}</p>
      <ul>
        {proposal.actions.map((action) => (
          <li key={action.actionId} data-testid={`proposal-action-${action.actionId}`}>
            <span>{action.intent}</span>{' '}
            <Button
              type="button"
              data-testid={`proposal-action-approve-${action.actionId}`}
              onClick={() => {
                onDecide(proposal.id, action.actionId, 'approved');
              }}
            >
              Onayla
            </Button>{' '}
            <Button
              type="button"
              variant="secondary"
              data-testid={`proposal-action-reject-${action.actionId}`}
              onClick={() => {
                onDecide(proposal.id, action.actionId, 'rejected');
              }}
            >
              Reddet
            </Button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function DecidedProposalRow({ proposal }: { proposal: CommandProposalSummary }) {
  return (
    <li data-testid={`proposal-decided-item-${proposal.id}`}>
      <p>{proposal.command}</p>
      <ul>
        {proposal.actions.map((action) => {
          const decision = decisionForAction(proposal.decisions, action.actionId);
          return (
            <li key={action.actionId}>
              <span>{action.intent}</span> <span>{decision?.status ?? 'bilinmiyor'}</span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function AutomationHistoryPanel({ workspaceId }: AutomationHistoryPanelProps) {
  const { data, isLoading, isError } = useProposalsQuery(workspaceId);
  const decideMutation = useDecideProposalMutation(workspaceId);

  function handleDecide(
    proposalId: string,
    actionId: string,
    decision: 'approved' | 'rejected',
  ): void {
    decideMutation.mutate({
      proposalId,
      decisions: [{ actionId, decision }],
    });
  }

  if (isLoading) {
    return (
      <div data-testid="automation-history-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="automation-history-error"
        title="Bir hata oluştu"
        description="Otomasyon geçmişi yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const proposals = data?.proposals ?? [];
  const pendingProposals = proposals.filter((proposal) => proposal.decidedAt === null);
  const decidedProposals = proposals.filter((proposal) => proposal.decidedAt !== null);

  return (
    <>
      {pendingProposals.length === 0 ? (
        <EmptyState
          data-testid="automation-history-pending-empty"
          title="Bekleyen bir aksiyon önerisi yok"
          description="Onay bekleyen bir otomasyon aksiyonu bulunmuyor."
        />
      ) : (
        <ul aria-label="Bekleyen aksiyon önerileri">
          {pendingProposals.map((proposal) => (
            <PendingProposalRow key={proposal.id} proposal={proposal} onDecide={handleDecide} />
          ))}
        </ul>
      )}

      <ul aria-label="Karara bağlanan aksiyon önerileri" data-testid="proposal-decided-section">
        {decidedProposals.map((proposal) => (
          <DecidedProposalRow key={proposal.id} proposal={proposal} />
        ))}
      </ul>
    </>
  );
}
