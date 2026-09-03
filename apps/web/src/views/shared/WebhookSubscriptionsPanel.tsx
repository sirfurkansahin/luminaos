import { useState } from 'react';
import { flushSync } from 'react-dom';

import {
  Button,
  Checkbox,
  DialogContent,
  DialogRoot,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
} from '@luminaos/ui';

import {
  useCreateWebhookSubscriptionMutation,
  useDeleteWebhookSubscriptionMutation,
  useWebhookSubscriptionsQuery,
} from '../../hooks/useWebhookSubscriptionsQuery.js';

import type { CreatedWebhookSubscription, WebhookSubscription } from '../../lib/apiClient.js';

/**
 * F2-T16 PR4 (ADR-0033 §g) -- "Webhook Abonelikleri" settings panel. Mirrors
 * `McpAccessPanel.tsx`'s exact four-state list + Dialog + `flushSync`
 * reveal-once secret pattern (there, a raw MCP token; here, a webhook
 * signing secret).
 */
export interface WebhookSubscriptionsPanelProps {
  workspaceId: string;
}

const ALLOWED_EVENT_TYPES = ['ActionsProposed', 'ActionsDecided'] as const;

function WebhookSubscriptionRow({
  subscription,
  onDelete,
}: {
  subscription: WebhookSubscription;
  onDelete: (subscriptionId: string) => void;
}) {
  return (
    <li data-testid={`webhook-subscription-item-${subscription.id}`}>
      <span>{subscription.targetUrl}</span> <span>{subscription.eventTypes.join(', ')}</span>{' '}
      <Button
        type="button"
        variant="secondary"
        data-testid={`webhook-subscription-delete-${subscription.id}`}
        onClick={() => {
          onDelete(subscription.id);
        }}
      >
        Sil
      </Button>
    </li>
  );
}

export function WebhookSubscriptionsPanel({ workspaceId }: WebhookSubscriptionsPanelProps) {
  const [open, setOpen] = useState(false);
  const [targetUrl, setTargetUrl] = useState('');
  const [checkedEventTypes, setCheckedEventTypes] = useState<Set<string>>(new Set());
  const [revealResult, setRevealResult] = useState<CreatedWebhookSubscription | undefined>(
    undefined,
  );

  const { data, isLoading, isError } = useWebhookSubscriptionsQuery(workspaceId);
  const createMutation = useCreateWebhookSubscriptionMutation(workspaceId);
  const deleteMutation = useDeleteWebhookSubscriptionMutation(workspaceId);

  function resetCreateForm(): void {
    setTargetUrl('');
    setCheckedEventTypes(new Set());
    setRevealResult(undefined);
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      resetCreateForm();
    }
  }

  function toggleEventType(eventType: string, checked: boolean): void {
    setCheckedEventTypes((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(eventType);
      } else {
        next.delete(eventType);
      }
      return next;
    });
  }

  function handleSubmit(): void {
    const trimmedUrl = targetUrl.trim();
    const eventTypes = [...checkedEventTypes];
    if (trimmedUrl.length === 0 || eventTypes.length === 0) {
      return;
    }
    createMutation.mutate(
      { targetUrl: trimmedUrl, eventTypes },
      {
        onSuccess: (result: { subscription: CreatedWebhookSubscription }) => {
          // `flushSync` forces a synchronous commit here because this
          // `onSuccess` may be invoked directly (outside any React event
          // handler/act()) -- e.g. by react-query itself after a promise
          // resolves, or (in tests) by manually calling the captured
          // callback -- where React 18's default async-batched commit would
          // otherwise leave the DOM stale until the next microtask/act flush.
          flushSync(() => {
            setRevealResult(result.subscription);
          });
        },
      },
    );
  }

  function handleDelete(subscriptionId: string): void {
    deleteMutation.mutate(subscriptionId);
  }

  function renderList(): React.JSX.Element {
    if (isLoading) {
      return (
        <div data-testid="webhook-subscriptions-loading">
          <Skeleton height={32} />
        </div>
      );
    }

    if (isError) {
      return (
        <EmptyState
          data-testid="webhook-subscriptions-error"
          title="Bir hata oluştu"
          description="Webhook abonelikleri yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
        />
      );
    }

    const subscriptions = data?.subscriptions ?? [];

    if (subscriptions.length === 0) {
      return (
        <EmptyState
          data-testid="webhook-subscriptions-empty"
          title="Henüz bir webhook aboneliği yok"
          description="Bu çalışma alanı için henüz bir webhook aboneliği oluşturulmadı."
        />
      );
    }

    return (
      <ul aria-label="Webhook abonelikleri">
        {subscriptions.map((subscription) => (
          <WebhookSubscriptionRow
            key={subscription.id}
            subscription={subscription}
            onDelete={handleDelete}
          />
        ))}
      </ul>
    );
  }

  function renderDialogBody(): React.JSX.Element {
    if (revealResult) {
      return (
        <div data-testid="webhook-subscription-reveal">
          <p data-testid="webhook-subscription-reveal-warning">
            Bu imzalama sırrı yalnızca bir kez gösterilir; kapattıktan sonra tekrar görüntülenemez.
            Güvenli bir yere kaydedin.
          </p>
          <code data-testid="webhook-subscription-secret">{revealResult.signingSecret}</code>
          <Button
            type="button"
            data-testid="webhook-subscription-reveal-close"
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
          data-testid="webhook-subscription-url-input"
          value={targetUrl}
          onChange={(event) => {
            setTargetUrl(event.target.value);
          }}
        />
        {ALLOWED_EVENT_TYPES.map((eventType) => (
          <label key={eventType}>
            <Checkbox
              data-testid={`webhook-subscription-eventtype-${eventType}`}
              checked={checkedEventTypes.has(eventType)}
              onCheckedChange={(checked) => {
                toggleEventType(eventType, checked === true);
              }}
            />
            {eventType}
          </label>
        ))}
        <Button
          type="button"
          data-testid="webhook-subscription-create-submit"
          onClick={handleSubmit}
        >
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
        data-testid="webhook-access-create-trigger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Yeni webhook aboneliği oluştur
      </Button>
      <DialogRoot open={open} onOpenChange={handleOpenChange}>
        <DialogContent data-testid="webhook-subscription-dialog">
          <DialogTitle>Yeni webhook aboneliği oluştur</DialogTitle>
          {renderDialogBody()}
        </DialogContent>
      </DialogRoot>
    </>
  );
}
