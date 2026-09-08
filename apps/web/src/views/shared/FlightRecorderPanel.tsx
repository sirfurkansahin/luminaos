import { Badge, EmptyState, Skeleton } from '@luminaos/ui';
import type { BadgeVariant } from '@luminaos/ui';

import { useAgentActionRecordsQuery } from '../../hooks/useAgentActionRecordsQuery.js';

import type { AgentActionRecord, ActionResourceReference } from '../../lib/apiClient.js';

/**
 * F3-T4 PR4 (ADR-0038 §h) -- "Uçuş Kayıt Cihazı" paneli: her ajan
 * aksiyonunun niyet/gerekçe/kaynaklar/geri-alma-planı/actor/occurredAt/
 * outcome bilgisini gösteren, tamamen SALT-OKUNUR bir liste.
 * `AutomationHistoryPanel.tsx`'in düz-liste-diyalogsuz konvansiyonunu
 * izler -- ama bekleyen/karara-bağlanan ayrımı ve onayla/reddet gibi hiçbir
 * aksiyon butonu YOK (F3-T6'nın kapsamı, bu görev yalnızca kaydeder).
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

function FlightRecorderRow({ record }: { record: AgentActionRecord }) {
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
    </li>
  );
}

export function FlightRecorderPanel({ workspaceId }: FlightRecorderPanelProps) {
  const { data, isLoading, isError } = useAgentActionRecordsQuery(workspaceId);

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

  return (
    <ul aria-label="Ajan aksiyon kayıtları" data-testid="flight-recorder-list">
      {records.map((record) => (
        <FlightRecorderRow key={record.id} record={record} />
      ))}
    </ul>
  );
}
