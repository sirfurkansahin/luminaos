import { useState } from 'react';
import { flushSync } from 'react-dom';

import { Button, EmptyState, Input, Skeleton } from '@luminaos/ui';

import { useAgentsQuery, useRegisterAgentMutation } from '../../hooks/useAgentsQuery.js';

import type { Agent } from '../../lib/apiClient.js';

/**
 * F3-T3 PR7a (ADR-0037 §b/§d) -- "Ajan Dizini" panel: combines
 * `AutomationHistoryPanel.tsx`'s plain-list-no-dialog top-level states with
 * `McpAccessPanel.tsx`'s inline register-form + mutate(vars, { onSuccess })
 * draft-clear-on-success convention.
 */
export interface AgentDirectoryPanelProps {
  workspaceId: string;
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <li data-testid={`agent-item-${agent.id}`}>
      <span>{agent.name}</span>
      <span>{agent.agentIdentifier}</span>
    </li>
  );
}

export function AgentDirectoryPanel({ workspaceId }: AgentDirectoryPanelProps) {
  const [name, setName] = useState('');
  const [agentIdentifier, setAgentIdentifier] = useState('');

  const { data, isLoading, isError } = useAgentsQuery(workspaceId);
  const registerMutation = useRegisterAgentMutation(workspaceId);

  function handleSubmit(): void {
    const trimmedName = name.trim();
    const trimmedIdentifier = agentIdentifier.trim();
    if (trimmedName.length === 0 || trimmedIdentifier.length === 0) {
      return;
    }
    registerMutation.mutate(
      { name: trimmedName, agentIdentifier: trimmedIdentifier },
      {
        onSuccess: () => {
          // `flushSync` mirrors McpAccessPanel.tsx's rationale -- this
          // `onSuccess` may run outside a React event handler/act().
          flushSync(() => {
            setName('');
            setAgentIdentifier('');
          });
        },
      },
    );
  }

  function renderList(): React.JSX.Element {
    if (isLoading) {
      return (
        <div data-testid="agent-directory-loading">
          <Skeleton height={32} />
        </div>
      );
    }

    if (isError) {
      return (
        <EmptyState
          data-testid="agent-directory-error"
          title="Bir hata oluştu"
          description="Ajan dizini yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
        />
      );
    }

    const activeAgents = (data?.agents ?? []).filter((agent) => agent.lifecycle === 'active');

    if (activeAgents.length === 0) {
      return (
        <EmptyState
          data-testid="agent-directory-empty"
          title="Henüz bir ajan yok"
          description="Bu çalışma alanı için henüz bir ajan kaydedilmedi."
        />
      );
    }

    return (
      <ul aria-label="Ajanlar">
        {activeAgents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </ul>
    );
  }

  return (
    <>
      {renderList()}
      <Input
        data-testid="agent-directory-name-input"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Input
        data-testid="agent-directory-identifier-input"
        value={agentIdentifier}
        onChange={(event) => {
          setAgentIdentifier(event.target.value);
        }}
      />
      <Button type="button" data-testid="agent-directory-register-button" onClick={handleSubmit}>
        Kaydet
      </Button>
    </>
  );
}
