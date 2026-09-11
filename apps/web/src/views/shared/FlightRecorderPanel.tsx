import { Badge, Button, EmptyState, Skeleton } from '@luminaos/ui';
import type { BadgeVariant } from '@luminaos/ui';

import {
  useAgentActionRecordsQuery,
  useUndoAgentActionMutation,
} from '../../hooks/useAgentActionRecordsQuery.js';

import type { AgentActionRecord, ActionResourceReference } from '../../lib/apiClient.js';

/**
 * F3-T4 PR4 (ADR-0038 §h) -- "Uçuş Kayıt Cihazı" paneli: her ajan
 * aksiyonunun niyet/gerekçe/kaynaklar/geri-alma-planı/actor/occurredAt/
 * outcome bilgisini gösteren, büyük ölçüde SALT-OKUNUR bir liste.
 * `AutomationHistoryPanel.tsx`'in düz-liste-diyalogsuz konvansiyonunu
 * izler -- bekleyen/karara-bağlanan ayrımı yok. F3-T6 PR3 (ADR-0040
 * §d/e/f/g) `rollbackPlan.kind === 'delete'` ve henüz geri alınmamış
 * kayıtlar için tek bir "Geri al" butonu ekler; `TriggerSuggestionsPanel.tsx`'in
 * aksiyon-butonu/isPending-disable/isError-mesajı konvansiyonunu izler.
 */
export interface FlightRecorderPanelProps {
  workspaceId: string;
}

const OUTCOME_LABEL: Record<AgentActionRecord['outcome'], string> = {
  succeeded: 'Başarılı',
  partially_succeeded: 'Kısmen başarılı',
  failed: 'Başarısız',
  rejected: 'Reddedildi',
};

const OUTCOME_BADGE_VARIANT: Record<AgentActionRecord['outcome'], BadgeVariant> = {
  succeeded: 'success',
  partially_succeeded: 'warning',
  failed: 'danger',
  rejected: 'neutral',
};

const ACTOR_TYPE_LABEL: Record<AgentActionRecord['actor']['type'], string> = {
  user: 'Kullanıcı',
  agent: 'Ajan',
  system: 'Sistem',
};

function describeResource(resource: ActionResourceReference): string {
  switch (resource.kind) {
    case 'object':
      return `Nesne: ${resource.objectId}`;
    case 'comment':
      return `Yorum: ${resource.commentId}`;
    case 'meeting':
      return `Toplantı: ${resource.meetingId}`;
    case 'agent':
      return `Ajan: ${resource.agentIdentifier}`;
    case 'external':
      return `Harici: ${resource.label}`;
  }
}

function FlightRecorderRow({
  record,
  canUndo,
  isUndoPending,
  onUndo,
}: {
  record: AgentActionRecord;
  canUndo: boolean;
  isUndoPending: boolean;
  onUndo: (recordId: string) => void;
}) {
  return (
    <li data-testid={`flight-recorder-item-${record.id}`}>
      <p>{record.intent}</p>
      <p>{record.rationale}</p>
      <p>
        {record.actionType} — {ACTOR_TYPE_LABEL[record.actor.type]} ({record.actor.type}):{' '}
        {record.actor.id}
      </p>
      <ul>
        {record.resources.map((resource, index) => (
          <li key={index}>{describeResource(resource)}</li>
        ))}
      </ul>
      <p>Geri alma planı: {record.rollbackPlan.description}</p>
      <p data-testid={`flight-recorder-occurred-${record.id}`}>
        {new Date(record.occurredAt).toLocaleString('tr-TR')}
      </p>
      <Badge
        variant={OUTCOME_BADGE_VARIANT[record.outcome]}
        data-testid={`flight-recorder-outcome-${record.id}`}
      >
        {OUTCOME_LABEL[record.outcome]}
      </Badge>
      {canUndo ? (
        <Button
          type="button"
          data-testid={`flight-recorder-undo-${record.id}`}
          disabled={isUndoPending}
          onClick={() => {
            onUndo(record.id);
          }}
        >
          Geri al
        </Button>
      ) : null}
    </li>
  );
}

export function FlightRecorderPanel({ workspaceId }: FlightRecorderPanelProps) {
  const { data, isLoading, isError } = useAgentActionRecordsQuery(workspaceId);
  const undoMutation = useUndoAgentActionMutation(workspaceId);

  if (isLoading) {
    return (
      <div data-testid="flight-recorder-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="flight-recorder-error"
        title="Bir hata oluştu"
        description="Uçuş kayıt cihazı yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const records = data?.records ?? [];

  if (records.length === 0) {
    return (
      <EmptyState
        data-testid="flight-recorder-empty"
        title="Henüz kayıt yok"
        description="Ajan aksiyonları burada, gerçekleştikçe görünecek."
      />
    );
  }

  const undoneRecordIds = new Set(
    records
      .map((record) => record.undoesRecordId)
      .filter((undoneId): undoneId is string => typeof undoneId === 'string'),
  );

  function handleUndo(recordId: string): void {
    undoMutation.mutate(recordId);
  }

  return (
    <>
      {undoMutation.isError ? (
        <EmptyState
          data-testid="flight-recorder-undo-error"
          title="Geri alma işlemi başarısız oldu"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      <ul aria-label="Ajan aksiyon kayıtları" data-testid="flight-recorder-list">
        {records.map((record) => (
          <FlightRecorderRow
            key={record.id}
            record={record}
            canUndo={record.rollbackPlan.kind === 'delete' && !undoneRecordIds.has(record.id)}
            isUndoPending={undoMutation.isPending}
            onUndo={handleUndo}
          />
        ))}
      </ul>
    </>
  );
}
