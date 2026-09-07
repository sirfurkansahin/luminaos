import { useState } from 'react';

import {
  Button,
  EmptyState,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from '@luminaos/ui';

import { useAgentsQuery } from '../../hooks/useAgentsQuery.js';
import { useDmMessagesQuery, useSendDmMessageMutation } from '../../hooks/useDmMessagesQuery.js';

import type { DmMessage } from '../../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

/**
 * F3-T3 PR7b (ADR-0037 §d) -- "Ajanla direkt mesajlaş" panel: an agent
 * picker (mirrors StatusPrioritySelect.tsx's SelectRoot/SelectTrigger/
 * SelectValue/SelectContent/SelectItem pattern) driving a message thread +
 * composer (mirrors CommentThread.tsx's composer contract exactly). Agent
 * replies whose `proposalId` is non-null render an in-page fragment anchor
 * to the matching pending-proposal row in `AutomationHistoryPanel`.
 */
export interface DirectMessagePanelProps {
  workspaceId: string;
}

function DmMessageRow({ message }: { message: DmMessage }) {
  const isAgentSent = message.sender === 'agent';
  return (
    <li data-testid={`dm-message-${message.id}`}>
      {isAgentSent ? 'Ajan: ' : ''}
      {message.body}
      {isAgentSent && message.proposalId !== null ? (
        <a
          data-testid={`dm-proposal-link-${message.id}`}
          href={`#proposal-item-${message.proposalId}`}
        >
          Yeniden yapılandırma önerisini görüntüle
        </a>
      ) : null}
    </li>
  );
}

export function DirectMessagePanel({ workspaceId }: DirectMessagePanelProps) {
  const agentsQuery = useAgentsQuery(workspaceId);
  const [pickedAgentIdentifier, setPickedAgentIdentifier] = useState<string | undefined>(undefined);

  const messagesQuery = useDmMessagesQuery(workspaceId, pickedAgentIdentifier ?? '');
  const sendMutation = useSendDmMessageMutation(workspaceId, pickedAgentIdentifier ?? '');

  const [draft, setDraft] = useState('');

  function submitDraft(): void {
    const text = draft.trim();
    if (text === '') {
      return;
    }
    sendMutation.mutate(text);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    }
  }

  function renderThread(): React.JSX.Element {
    if (messagesQuery.isLoading) {
      return (
        <div data-testid="dm-thread-loading">
          <Skeleton height={32} />
        </div>
      );
    }

    if (messagesQuery.isError) {
      return (
        <EmptyState
          data-testid="dm-thread-error"
          title="Bir hata oluştu"
          description="Mesajlar yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
        />
      );
    }

    const messages = messagesQuery.data?.messages ?? [];

    return (
      <>
        {messages.length === 0 ? (
          <EmptyState
            data-testid="dm-thread-empty"
            title="Henüz mesaj yok"
            description="Bu ajanla henüz mesajlaşmadınız."
          />
        ) : (
          <ul aria-label="Direkt mesajlar">
            {messages.map((message) => (
              <DmMessageRow key={message.id} message={message} />
            ))}
          </ul>
        )}
        <div>
          <Textarea
            data-testid="dm-composer-input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={handleKeyDown}
          />
          <Button
            type="button"
            data-testid="dm-composer-submit"
            onClick={() => {
              submitDraft();
            }}
          >
            Gönder
          </Button>
        </div>
      </>
    );
  }

  if (agentsQuery.isLoading) {
    return (
      <div data-testid="dm-panel-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (agentsQuery.isError) {
    return (
      <EmptyState
        data-testid="dm-panel-error"
        title="Bir hata oluştu"
        description="Ajanlar yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const activeAgents = (agentsQuery.data?.agents ?? []).filter(
    (agent) => agent.lifecycle === 'active',
  );

  if (activeAgents.length === 0) {
    return (
      <EmptyState
        data-testid="dm-panel-empty"
        title="Mesajlaşılacak bir ajan yok"
        description="Bu çalışma alanı için henüz bir ajan kaydedilmedi."
      />
    );
  }

  return (
    <>
      <SelectRoot
        onValueChange={(value) => {
          setPickedAgentIdentifier(value);
        }}
      >
        <SelectTrigger data-testid="dm-agent-picker" aria-label="Ajan seç">
          <SelectValue placeholder="Ajan seç" />
        </SelectTrigger>
        <SelectContent>
          {activeAgents.map((agent) => (
            <SelectItem key={agent.id} value={agent.agentIdentifier}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
      {pickedAgentIdentifier !== undefined ? renderThread() : null}
    </>
  );
}
