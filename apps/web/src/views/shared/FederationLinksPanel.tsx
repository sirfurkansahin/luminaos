import { useState } from 'react';
import { flushSync } from 'react-dom';

import { Button, EmptyState, Input, Skeleton } from '@luminaos/ui';

import {
  useCreateFederationCredentialMutation,
  useRevokeFederationCredentialMutation,
} from '../../hooks/useFederationCredentialsMutation.js';
import {
  useAcceptFederationLinkMutation,
  useFederationLinksQuery,
  useInitiateFederationLinkMutation,
  useRevokeFederationLinkMutation,
} from '../../hooks/useFederationLinksQuery.js';
import {
  useAddFederationScopeObjectMutation,
  useFederationScopeQuery,
  useRemoveFederationScopeObjectMutation,
} from '../../hooks/useFederationScopeQuery.js';

import type {
  CreateFederationCredentialResult,
  FederationLink,
  FederationLinkCredential,
} from '../../lib/apiClient.js';

/**
 * F3-T14 PR3 (ADR-0048, spec Kabul Kriterleri) -- "Federatif Bağlantılar"
 * management panel. Combines `McpAccessPanel.tsx`'s reveal-once credential
 * pattern with `AutonomyTierPanel.tsx`'s RBAC-via-prop convention: every
 * management action (initiate/accept/revoke, scope add/remove, credential
 * create/revoke) is `admin+`-gated by the `isAdmin` prop -- real enforcement
 * is the server's 403 either way, this is a UI nicety, not a security
 * boundary. Reading the link list itself is `member+` and always visible.
 */
export interface FederationLinksPanelProps {
  workspaceId: string;
  isAdmin: boolean;
}

const STATUS_LABELS: Record<FederationLink['status'], string> = {
  pending: 'Beklemede',
  active: 'Aktif',
  revoked: 'İptal edildi',
};

function FederationLinkRow({
  link,
  workspaceId,
  isAdmin,
}: {
  link: FederationLink;
  workspaceId: string;
  isAdmin: boolean;
}) {
  const acceptMutation = useAcceptFederationLinkMutation(workspaceId);
  const revokeMutation = useRevokeFederationLinkMutation(workspaceId);
  const scopeQuery = useFederationScopeQuery(workspaceId, link.id);
  const addScopeMutation = useAddFederationScopeObjectMutation(workspaceId, link.id);
  const removeScopeMutation = useRemoveFederationScopeObjectMutation(workspaceId, link.id);
  const createCredentialMutation = useCreateFederationCredentialMutation(workspaceId, link.id);
  const revokeCredentialMutation = useRevokeFederationCredentialMutation(workspaceId, link.id);

  const [scopeObjectIdInput, setScopeObjectIdInput] = useState('');
  const [credentialName, setCredentialName] = useState('');
  const [credentials, setCredentials] = useState<FederationLinkCredential[]>([]);
  const [revealedRawToken, setRevealedRawToken] = useState<string | undefined>(undefined);

  function handleAddScopeObject(): void {
    const trimmed = scopeObjectIdInput.trim();
    if (trimmed.length === 0) {
      return;
    }
    addScopeMutation.mutate({ objectId: trimmed });
    setScopeObjectIdInput('');
  }

  function handleRemoveScopeObject(objectId: string): void {
    removeScopeMutation.mutate(objectId);
  }

  function handleCreateCredential(): void {
    const trimmed = credentialName.trim();
    if (trimmed.length === 0) {
      return;
    }
    createCredentialMutation.mutate(
      { name: trimmed },
      {
        onSuccess: (result: CreateFederationCredentialResult) => {
          // `flushSync` forces a synchronous commit here for the same reason
          // `McpAccessPanel.tsx`'s identical reveal-once flow does -- this
          // `onSuccess` may be invoked outside any React event handler/act().
          flushSync(() => {
            setCredentials((previous) => [...previous, result.credential]);
            setRevealedRawToken(result.rawToken);
          });
        },
      },
    );
    setCredentialName('');
  }

  function handleRevokeCredential(credentialId: string): void {
    revokeCredentialMutation.mutate(credentialId);
  }

  return (
    <li data-testid={`federation-link-item-${link.id}`}>
      <span data-testid={`federation-link-status-${link.id}`}>{STATUS_LABELS[link.status]}</span>

      {isAdmin && link.status === 'pending' ? (
        <>
          <Button
            type="button"
            data-testid={`federation-link-accept-${link.id}`}
            onClick={() => {
              acceptMutation.mutate(link.id);
            }}
          >
            Kabul et
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid={`federation-link-revoke-${link.id}`}
            onClick={() => {
              revokeMutation.mutate(link.id);
            }}
          >
            İptal et
          </Button>
        </>
      ) : null}

      {isAdmin && link.status === 'active' ? (
        <>
          <Button
            type="button"
            variant="secondary"
            data-testid={`federation-link-revoke-${link.id}`}
            onClick={() => {
              revokeMutation.mutate(link.id);
            }}
          >
            İptal et
          </Button>

          <div data-testid={`federation-link-scope-section-${link.id}`}>
            <ul aria-label="Kapsam nesneleri">
              {(scopeQuery.data?.scopeObjects ?? []).map((scopeObject) => (
                <li
                  key={scopeObject.id}
                  data-testid={`federation-scope-item-${link.id}-${scopeObject.objectId}`}
                >
                  <span>{scopeObject.objectId}</span>
                  <Button
                    type="button"
                    variant="secondary"
                    data-testid={`federation-scope-remove-${link.id}-${scopeObject.objectId}`}
                    onClick={() => {
                      handleRemoveScopeObject(scopeObject.objectId);
                    }}
                  >
                    Kaldır
                  </Button>
                </li>
              ))}
            </ul>
            <Input
              data-testid={`federation-scope-add-input-${link.id}`}
              value={scopeObjectIdInput}
              onChange={(event) => {
                setScopeObjectIdInput(event.target.value);
              }}
            />
            <Button
              type="button"
              data-testid={`federation-scope-add-submit-${link.id}`}
              onClick={handleAddScopeObject}
            >
              Kapsama ekle
            </Button>
          </div>

          <div data-testid={`federation-credential-section-${link.id}`}>
            {revealedRawToken !== undefined ? (
              <div data-testid={`federation-credential-raw-token-${link.id}`}>
                {revealedRawToken}
                <Button
                  type="button"
                  data-testid={`federation-credential-reveal-close-${link.id}`}
                  onClick={() => {
                    setRevealedRawToken(undefined);
                  }}
                >
                  Kapat
                </Button>
              </div>
            ) : (
              <>
                <Input
                  data-testid={`federation-credential-name-input-${link.id}`}
                  value={credentialName}
                  onChange={(event) => {
                    setCredentialName(event.target.value);
                  }}
                />
                <Button
                  type="button"
                  data-testid={`federation-credential-create-submit-${link.id}`}
                  onClick={handleCreateCredential}
                >
                  Credential oluştur
                </Button>
              </>
            )}
            <ul aria-label="Federasyon credential'ları">
              {credentials.map((credential) => (
                <li
                  key={credential.id}
                  data-testid={`federation-credential-item-${link.id}-${credential.id}`}
                >
                  <span>{credential.name}</span>
                  <span>{credential.tokenPrefix}</span>
                  {credential.revokedAt === null ? (
                    <Button
                      type="button"
                      variant="secondary"
                      data-testid={`federation-credential-revoke-${link.id}-${credential.id}`}
                      onClick={() => {
                        handleRevokeCredential(credential.id);
                      }}
                    >
                      İptal et
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </li>
  );
}

export function FederationLinksPanel({ workspaceId, isAdmin }: FederationLinksPanelProps) {
  const { data, isLoading, isError } = useFederationLinksQuery(workspaceId);
  const initiateMutation = useInitiateFederationLinkMutation(workspaceId);

  const [counterpartWorkspaceId, setCounterpartWorkspaceId] = useState('');

  function handleInitiate(): void {
    const trimmed = counterpartWorkspaceId.trim();
    if (trimmed.length === 0) {
      return;
    }
    initiateMutation.mutate({ counterpartWorkspaceId: trimmed });
    setCounterpartWorkspaceId('');
  }

  if (isLoading) {
    return (
      <div data-testid="federation-links-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="federation-links-error"
        title="Bir hata oluştu"
        description="Federasyon bağlantıları yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const links = data?.links ?? [];

  return (
    <>
      {isAdmin ? (
        <div>
          <Input
            data-testid="federation-link-initiate-input"
            value={counterpartWorkspaceId}
            onChange={(event) => {
              setCounterpartWorkspaceId(event.target.value);
            }}
          />
          <Button
            type="button"
            data-testid="federation-link-initiate-submit"
            onClick={handleInitiate}
          >
            Bağlantı başlat
          </Button>
        </div>
      ) : null}

      <ul aria-label="Federasyon bağlantıları">
        {links.map((link) => (
          <FederationLinkRow
            key={link.id}
            link={link}
            workspaceId={workspaceId}
            isAdmin={isAdmin}
          />
        ))}
      </ul>
    </>
  );
}
