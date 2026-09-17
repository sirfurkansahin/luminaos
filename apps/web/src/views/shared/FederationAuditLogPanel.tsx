import { EmptyState, Skeleton } from '@luminaos/ui';

import { useFederationAuditLogQuery } from '../../hooks/useFederationAuditLogQuery.js';

import type { FederationAuditEvent } from '../../lib/apiClient.js';

/**
 * F3-T14 PR3 (ADR-0048 §h/RBAC özeti "member+", spec Kabul Kriterleri) --
 * own-workspace federation audit-log viewing panel. Deliberately has NO
 * `isAdmin`/RBAC prop (unlike `FederationLinksPanel`) -- reading one's own
 * workspace's federation audit log is `member+` (ADR-0016 §a: read paths are
 * never role-gated beyond plain membership), enforced server-side only.
 */
export interface FederationAuditLogPanelProps {
  workspaceId: string;
  linkId: string;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatOccurredAt(event: FederationAuditEvent): string {
  return DATE_FORMATTER.format(new Date(event.occurredAt));
}

function FederationAuditLogRow({ event }: { event: FederationAuditEvent }) {
  return (
    <li data-testid={`federation-audit-log-item-${event.id}`}>
      {event.type === 'FederatedContextAccessed' ? (
        <span data-testid={`federation-audit-log-type-accessed-${event.id}`}>
          Bağlamınız karşı çalışma alanı tarafından erişildi
        </span>
      ) : (
        <span data-testid={`federation-audit-log-type-requested-${event.id}`}>
          Karşı çalışma alanının bağlamı talep edildi
        </span>
      )}
      <span>{formatOccurredAt(event)}</span>
    </li>
  );
}

export function FederationAuditLogPanel({ workspaceId, linkId }: FederationAuditLogPanelProps) {
  const { data, isLoading, isError } = useFederationAuditLogQuery(workspaceId, linkId);

  if (isLoading) {
    return (
      <div data-testid="federation-audit-log-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="federation-audit-log-error"
        title="Bir hata oluştu"
        description="Federasyon denetim günlüğü yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const events = data?.events ?? [];

  if (events.length === 0) {
    return (
      <EmptyState
        data-testid="federation-audit-log-empty"
        title="Henüz bir denetim kaydı yok"
        description="Bu federasyon bağlantısı için henüz erişim/talep kaydı oluşmadı."
      />
    );
  }

  return (
    <ul aria-label="Federasyon denetim günlüğü">
      {events.map((event) => (
        <FederationAuditLogRow key={event.id} event={event} />
      ))}
    </ul>
  );
}
