import { Button, EmptyState, Skeleton } from '@luminaos/ui';

import {
  useDecideTriggerSuggestionMutation,
  useRunTriggerSuggestionsAnalysisMutation,
  useTriggerSuggestionsQuery,
} from '../../hooks/useTriggerSuggestionsQuery.js';

import type { TriggerTemplateSuggestionSummary } from '../../lib/apiClient.js';

/**
 * F2-T17 PR3 (ADR-0034, spec Kabul Kriterleri: "bekleyen öneriler listesi +
 * gerekçe, 'Şimdi analiz et' butonu, onay/red aksiyonları") -- combines
 * `AutomationHistoryPanel.tsx`'s exact pending/decided-split, no-dialog
 * convention with a new "Şimdi analiz et" button wired to a separate
 * no-argument analysis mutation. Calls `useTriggerSuggestionsQuery(workspaceId)`
 * ONCE with no filter, splitting `data.suggestions` client-side by
 * `status === 'pending'`.
 */
export interface TriggerSuggestionsPanelProps {
  workspaceId: string;
}

function statusLabel(status: TriggerTemplateSuggestionSummary['status']): string {
  switch (status) {
    case 'approved':
      return 'Onaylandı (approved)';
    case 'rejected':
      return 'Reddedildi (rejected)';
    default:
      return status;
  }
}

function PendingSuggestionRow({
  suggestion,
  onDecide,
}: {
  suggestion: TriggerTemplateSuggestionSummary;
  onDecide: (suggestionId: string, decision: 'approve' | 'reject') => void;
}) {
  return (
    <li data-testid={`trigger-suggestion-item-${suggestion.id}`}>
      <p>{suggestion.name}</p>
      <p>{suggestion.rationale}</p>
      <Button
        type="button"
        data-testid={`trigger-suggestion-approve-${suggestion.id}`}
        onClick={() => {
          onDecide(suggestion.id, 'approve');
        }}
      >
        Onayla
      </Button>{' '}
      <Button
        type="button"
        variant="secondary"
        data-testid={`trigger-suggestion-reject-${suggestion.id}`}
        onClick={() => {
          onDecide(suggestion.id, 'reject');
        }}
      >
        Reddet
      </Button>
    </li>
  );
}

function DecidedSuggestionRow({ suggestion }: { suggestion: TriggerTemplateSuggestionSummary }) {
  return (
    <li data-testid={`trigger-suggestion-decided-item-${suggestion.id}`}>
      <p>{suggestion.name}</p>
      <span>{statusLabel(suggestion.status)}</span>
    </li>
  );
}

export function TriggerSuggestionsPanel({ workspaceId }: TriggerSuggestionsPanelProps) {
  const { data, isLoading, isError } = useTriggerSuggestionsQuery(workspaceId);
  const analyzeMutation = useRunTriggerSuggestionsAnalysisMutation(workspaceId);
  const decideMutation = useDecideTriggerSuggestionMutation(workspaceId);

  function handleDecide(suggestionId: string, decision: 'approve' | 'reject'): void {
    decideMutation.mutate({ suggestionId, decision });
  }

  if (isLoading) {
    return (
      <div data-testid="trigger-suggestions-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="trigger-suggestions-error"
        title="Bir hata oluştu"
        description="Tetikleyici önerileri yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const suggestions = data?.suggestions ?? [];
  const pendingSuggestions = suggestions.filter((suggestion) => suggestion.status === 'pending');
  const decidedSuggestions = suggestions.filter((suggestion) => suggestion.status !== 'pending');

  return (
    <>
      <Button
        type="button"
        data-testid="trigger-suggestions-analyze-button"
        disabled={analyzeMutation.isPending}
        onClick={() => {
          analyzeMutation.mutate();
        }}
      >
        Şimdi analiz et
      </Button>

      {analyzeMutation.isError ? (
        <EmptyState
          data-testid="trigger-suggestions-analyze-error"
          title="Analiz şu anda çalıştırılamadı"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      {pendingSuggestions.length === 0 ? (
        <EmptyState
          data-testid="trigger-suggestions-pending-empty"
          title="Bekleyen bir tetikleyici önerisi yok"
          description="Onay bekleyen bir otomasyon tetikleyici önerisi bulunmuyor."
        />
      ) : (
        <ul aria-label="Bekleyen tetikleyici önerileri">
          {pendingSuggestions.map((suggestion) => (
            <PendingSuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              onDecide={handleDecide}
            />
          ))}
        </ul>
      )}

      <ul
        aria-label="Karara bağlanan tetikleyici önerileri"
        data-testid="trigger-suggestion-decided-section"
      >
        {decidedSuggestions.map((suggestion) => (
          <DecidedSuggestionRow key={suggestion.id} suggestion={suggestion} />
        ))}
      </ul>
    </>
  );
}
