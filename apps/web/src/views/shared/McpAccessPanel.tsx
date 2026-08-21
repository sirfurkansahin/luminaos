import { useState } from 'react';
import { flushSync } from 'react-dom';

import {
  Button,
  DialogContent,
  DialogRoot,
  DialogTitle,
  EmptyState,
  Input,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@luminaos/ui';

import {
  useCreateMcpGrantMutation,
  useMcpGrantsQuery,
  useRevokeMcpGrantMutation,
} from '../../hooks/useMcpGrantsQuery.js';

import type { CreateMcpClientGrantResult, McpClientGrant } from '../../lib/apiClient.js';

/**
 * F2-T12 PR2 (ADR-0028 §k/§l) -- "MCP Erişimi" settings panel. Combines
 * `IntegrationsPanel.tsx`'s list-rendering convention (list rendered
 * directly, not gated behind a dialog) with `MemoryPassportPanel.tsx`'s
 * Dialog open/close mechanics (only the creation flow lives behind a
 * dialog). Per ADR-0028 §l: fixed 30/90/365-day duration menu, default 90,
 * no "never expires"/custom-date escape hatch.
 */
export interface McpAccessPanelProps {
  workspaceId: string;
}

const EXPIRES_AT_DAYS_OPTIONS = [30, 90, 365] as const;
type ExpiresAtDays = (typeof EXPIRES_AT_DAYS_OPTIONS)[number];
const DEFAULT_EXPIRES_AT_DAYS: ExpiresAtDays = 90;

function isExpiresAtDays(value: string): value is `${ExpiresAtDays}` {
  return (EXPIRES_AT_DAYS_OPTIONS as readonly number[]).includes(Number(value));
}

const DATE_FORMATTER = new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatCreatedAt(grant: McpClientGrant): string {
  return `${DATE_FORMATTER.format(new Date(grant.createdAt))} tarihinde oluşturuldu`;
}

function McpGrantRow({
  grant,
  onRevoke,
}: {
  grant: McpClientGrant;
  onRevoke: (grantId: string) => void;
}) {
  const isRevoked = grant.revokedAt !== null;

  return (
    <li data-testid={`mcp-grant-item-${grant.id}`}>
      <span>{grant.name}</span>
      <span>{grant.tokenPrefix}</span>
      <span>{formatCreatedAt(grant)}</span>
      <span data-testid={`mcp-grant-status-${grant.id}`}>
        {isRevoked ? 'İptal edildi' : 'Aktif'}
      </span>
      {isRevoked ? null : (
        <Button
          type="button"
          variant="secondary"
          data-testid={`mcp-grant-revoke-${grant.id}`}
          onClick={() => {
            onRevoke(grant.id);
          }}
        >
          Sil
        </Button>
      )}
    </li>
  );
}

export function McpAccessPanel({ workspaceId }: McpAccessPanelProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiresAtDays, setExpiresAtDays] = useState<ExpiresAtDays>(DEFAULT_EXPIRES_AT_DAYS);
  const [revealResult, setRevealResult] = useState<CreateMcpClientGrantResult | undefined>(
    undefined,
  );

  const { data, isLoading, isError } = useMcpGrantsQuery(workspaceId);
  const createMutation = useCreateMcpGrantMutation(workspaceId);
  const revokeMutation = useRevokeMcpGrantMutation(workspaceId);

  function resetCreateForm(): void {
    setName('');
    setExpiresAtDays(DEFAULT_EXPIRES_AT_DAYS);
    setRevealResult(undefined);
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      resetCreateForm();
    }
  }

  function handleSubmit(): void {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return;
    }
    createMutation.mutate(
      { name: trimmedName, expiresAtDays },
      {
        onSuccess: (result: CreateMcpClientGrantResult) => {
          // `flushSync` forces a synchronous commit here because this
          // `onSuccess` may be invoked directly (outside any React event
          // handler/act()) -- e.g. by react-query itself after a promise
          // resolves, or (in tests) by manually calling the captured
          // callback -- where React 18's default async-batched commit would
          // otherwise leave the DOM stale until the next microtask/act flush.
          flushSync(() => {
            setRevealResult(result);
          });
        },
      },
    );
  }

  function handleRevoke(grantId: string): void {
    revokeMutation.mutate(grantId);
  }

  function renderList(): React.JSX.Element {
    if (isLoading) {
      return (
        <div data-testid="mcp-grants-loading">
          <Skeleton height={32} />
        </div>
      );
    }

    if (isError) {
      return (
        <EmptyState
          data-testid="mcp-grants-error"
          title="Bir hata oluştu"
          description="MCP erişim token'ları yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
        />
      );
    }

    const grants = data?.grants ?? [];

    if (grants.length === 0) {
      return (
        <EmptyState
          data-testid="mcp-grants-empty"
          title="Henüz bir MCP erişim token'ı yok"
          description="Bu çalışma alanı için henüz bir MCP istemci token'ı oluşturulmadı."
        />
      );
    }

    return (
      <ul aria-label="MCP erişim token'ları">
        {grants.map((grant) => (
          <McpGrantRow key={grant.id} grant={grant} onRevoke={handleRevoke} />
        ))}
      </ul>
    );
  }

  function renderDialogBody(): React.JSX.Element {
    if (revealResult) {
      return (
        <div data-testid="mcp-grant-reveal">
          <p data-testid="mcp-grant-reveal-warning">
            Bu token yalnızca bir kez gösterilir; kapattıktan sonra tekrar görüntülenemez. Güvenli
            bir yere kaydedin.
          </p>
          <code data-testid="mcp-grant-raw-token">{revealResult.rawToken}</code>
          <Button
            type="button"
            data-testid="mcp-grant-reveal-close"
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            Kapat
          </Button>
        </div>
      );
    }

    return (
      <div>
        <Input
          data-testid="mcp-grant-name-input"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <SelectRoot
          value={String(expiresAtDays)}
          onValueChange={(next) => {
            if (isExpiresAtDays(next)) {
              setExpiresAtDays(Number(next) as ExpiresAtDays);
            }
          }}
        >
          <SelectTrigger data-testid="mcp-grant-duration-select" aria-label="Geçerlilik süresi">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRES_AT_DAYS_OPTIONS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {days} gün
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <Button type="button" data-testid="mcp-grant-create-submit" onClick={handleSubmit}>
          Oluştur
        </Button>
      </div>
    );
  }

  return (
    <>
      {renderList()}
      <Button
        type="button"
        data-testid="mcp-access-create-trigger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Yeni token oluştur
      </Button>
      <DialogRoot open={open} onOpenChange={handleOpenChange}>
        <DialogContent data-testid="mcp-access-dialog">
          <DialogTitle>Yeni MCP erişim token&apos;ı oluştur</DialogTitle>
          {renderDialogBody()}
        </DialogContent>
      </DialogRoot>
    </>
  );
}
