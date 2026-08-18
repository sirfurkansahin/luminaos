import { Button, EmptyState, Skeleton } from '@luminaos/ui';

import {
  useConnectIntegrationMutation,
  useDisconnectIntegrationMutation,
  useIntegrationsQuery,
} from '../../hooks/useIntegrationsQuery.js';

/**
 * F2-T10 PR1 (ADR-0026 §c/§n) -- minimal "Entegrasyonlar" settings panel,
 * mirroring `MemoryPassportPanel`'s plain-JSX-sibling-in-App.tsx mounting
 * convention (no new router). Deliberately CONNECTOR-AGNOSTIC: renders
 * whatever `useIntegrationsQuery` reports, with no Notion-specific (or any
 * other connectorType-specific) branching.
 */
export interface IntegrationsPanelProps {
  workspaceId: string;
}

function IntegrationRow({
  connectorType,
  connected,
  onConnect,
  onDisconnect,
}: {
  connectorType: string;
  connected: boolean;
  onConnect: (connectorType: string) => void;
  onDisconnect: (connectorType: string) => void;
}) {
  return (
    <li data-testid={`integration-item-${connectorType}`}>
      <span>{connectorType}</span>
      <span data-testid={`integration-status-${connectorType}`}>
        {connected ? 'Bağlı' : 'Bağlı değil'}
      </span>
      {connected ? (
        <Button
          type="button"
          variant="secondary"
          data-testid={`integration-disconnect-${connectorType}`}
          onClick={() => {
            onDisconnect(connectorType);
          }}
        >
          Bağlantıyı Kes
        </Button>
      ) : (
        <Button
          type="button"
          data-testid={`integration-connect-${connectorType}`}
          onClick={() => {
            onConnect(connectorType);
          }}
        >
          Bağlan
        </Button>
      )}
    </li>
  );
}

export function IntegrationsPanel({ workspaceId }: IntegrationsPanelProps) {
  const { data, isLoading, isError } = useIntegrationsQuery(workspaceId);
  const connectMutation = useConnectIntegrationMutation(workspaceId);
  const disconnectMutation = useDisconnectIntegrationMutation(workspaceId);

  function handleConnect(connectorType: string): void {
    connectMutation.mutate(connectorType, {
      onSuccess: (result: { authorizeUrl: string }) => {
        window.location.assign(result.authorizeUrl);
      },
    });
  }

  function handleDisconnect(connectorType: string): void {
    disconnectMutation.mutate(connectorType);
  }

  if (isLoading) {
    return (
      <div data-testid="integrations-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="integrations-error"
        title="Bir hata oluştu"
        description="Entegrasyonlar yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const connectors = data?.connectors ?? [];

  if (connectors.length === 0) {
    return (
      <EmptyState
        data-testid="integrations-empty"
        title="Henüz bir entegrasyon yok"
        description="Bu çalışma alanı için henüz bir bağlayıcı yapılandırılmadı."
      />
    );
  }

  return (
    <ul aria-label="Entegrasyonlar">
      {connectors.map((connector) => (
        <IntegrationRow
          key={connector.connectorType}
          connectorType={connector.connectorType}
          connected={connector.connected}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
      ))}
    </ul>
  );
}
