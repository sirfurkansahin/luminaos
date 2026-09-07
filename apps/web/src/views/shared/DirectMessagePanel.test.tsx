import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectMessagePanel as DirectMessagePanelModuleExport } from './DirectMessagePanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T3 PR7b (ADR-0037 §d) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/views/shared/DirectMessagePanel.tsx to satisfy these tests):
 *
 *   export interface DirectMessagePanelProps { workspaceId: string; }
 *   export function DirectMessagePanel(props: DirectMessagePanelProps): React.JSX.Element;
 *
 * Fetches the agent directory via `useAgentsQuery(workspaceId)`
 * (../../hooks/useAgentsQuery.ts, mocked wholesale below — same module PR7a's
 * `AgentDirectoryPanel`/`CommentThread` already consume) to populate an agent
 * picker, then, once an agent is picked, the message thread for that
 * `(workspaceId, agentIdentifier)` pair via `useDmMessagesQuery`/
 * `useSendDmMessageMutation` (../../hooks/useDmMessagesQuery.ts, mocked
 * wholesale below — does not exist yet).
 *
 * Top-level states, keyed OFF `useAgentsQuery`'s `{ data, isLoading,
 * isError }` (gates the WHOLE panel, including the picker):
 *   - isLoading -> data-testid="dm-panel-loading"
 *   - isError -> data-testid="dm-panel-error"
 *   - data.agents.length === 0 -> data-testid="dm-panel-empty" (no agent
 *     exists to DM with yet)
 *   - otherwise -> an agent picker, `@luminaos/ui`'s real (non-mocked)
 *     `SelectRoot`/`SelectTrigger` (data-testid="dm-agent-picker", each
 *     agent's `name` as one `SelectItem`'s visible text, `value`=
 *     `agent.agentIdentifier`) is rendered. Deactivated agents (`lifecycle
 *     === 'deactivated'`) are NOT offered as options (mirrors
 *     CommentThread's mention-suggestion filtering).
 *
 * No thread/composer is rendered until an agent has been picked (no
 * `agentIdentifier` selected yet) -- selecting an option in the picker is
 * what causes `useDmMessagesQuery(workspaceId, pickedAgentIdentifier)` /
 * `useSendDmMessageMutation(workspaceId, pickedAgentIdentifier)` to be
 * called with that identifier (asserted below by inspecting the mocked
 * hooks' call history, which tolerates the hooks having ALSO been called
 * with some other/undefined identifier during earlier renders before a pick
 * was made).
 *
 * Once an agent is picked, the thread section's states are keyed OFF
 * `useDmMessagesQuery`'s `{ data, isLoading, isError }`:
 *   - isLoading -> data-testid="dm-thread-loading"
 *   - isError -> data-testid="dm-thread-error"
 *   - data.messages.length === 0 -> data-testid="dm-thread-empty" (the
 *     composer below is STILL rendered in this state, so a user can send the
 *     first message)
 *   - otherwise -> `<ul aria-label="Direkt mesajlar">`, one `<li
 *     data-testid="dm-message-<id>">` PER message, in the SAME order as
 *     `data.messages` (no client-side re-sorting). Each row's text content
 *     includes the message's `body`. When `sender === 'agent'`, the row's
 *     text is prefixed with "Ajan: " (e.g. "Ajan: <body>"); a `'user'`-sent
 *     row has NO such prefix anywhere in its text (mirrors CommentThread's
 *     "Ajan: " convention).
 *
 * Reconfiguration proposal banner (ADR-0037 §d — links to the existing
 * Command Proposals decide UI via `AutomationHistoryPanel`'s pending-proposal
 * row, which now also carries `id={`proposal-item-${proposal.id}`}` in
 * addition to its existing `data-testid`): when a message row's `sender ===
 * 'agent'` AND `proposalId !== null`, that row ALSO renders an anchor
 * (`<a>`) `data-testid=`dm-proposal-link-${message.id}`` whose `href` is
 * `#proposal-item-${message.proposalId}`. When `proposalId` is `null`, OR
 * the message is user-sent (even if `proposalId` happened to be non-null),
 * NO such anchor renders for that message.
 *
 * The composer (rendered in EVERY thread state except loading/error -- i.e.
 * whenever an agent is picked and the dm-messages query has resolved,
 * whether empty or non-empty), mirroring CommentThread's composer contract
 * exactly:
 *   - `@luminaos/ui` `Textarea` data-testid="dm-composer-input"
 *   - `@luminaos/ui` `Button` data-testid="dm-composer-submit", Turkish
 *     label containing "Gönder"
 *   - submitting (button click, OR pressing Enter WITHOUT Shift inside the
 *     textarea -- Shift+Enter must NOT submit, it inserts a newline) with a
 *     non-empty/non-whitespace draft calls `useSendDmMessageMutation(
 *     workspaceId, pickedAgentIdentifier)`'s `mutate` with EXACTLY the
 *     trimmed draft string, then clears the draft back to ''.
 *   - submitting with an empty/whitespace-only draft is a no-op (mutate NOT
 *     called, draft left as-is).
 *
 * `useAgentsQuery` (../../hooks/useAgentsQuery.ts) and
 * `useDmMessagesQuery`/`useSendDmMessageMutation`
 * (../../hooks/useDmMessagesQuery.ts) do not exist yet (the latter module at
 * all), so — mirroring CommentThread.test.tsx's handling of the equally-not-
 * yet-existing hooks — mock functions are created via `vi.hoisted` and
 * referenced ONLY by closure inside the `vi.mock` factories below; this file
 * never imports either hook module itself. The `Agent`/`DmMessage` shapes
 * are declared locally for the same reason. `./DirectMessagePanel.tsx`
 * itself DOES NOT exist yet either — imported directly (`ModuleExport`
 * cast), so this test file is expected to fail to even resolve that import
 * until the component exists — the documented TDD red state.
 */

interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: string;
}

interface DmMessage {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  sender: 'user' | 'agent';
  body: string;
  proposalId: string | null;
  createdAt: string;
}

const { mockedUseAgentsQuery, mockedUseDmMessagesQuery, mockedUseSendDmMessageMutation } =
  vi.hoisted(() => {
    return {
      mockedUseAgentsQuery: vi.fn(),
      mockedUseDmMessagesQuery: vi.fn(),
      mockedUseSendDmMessageMutation: vi.fn(),
    };
  });

vi.mock('../../hooks/useAgentsQuery.js', () => ({
  useAgentsQuery: mockedUseAgentsQuery,
}));

vi.mock('../../hooks/useDmMessagesQuery.js', () => ({
  useDmMessagesQuery: mockedUseDmMessagesQuery,
  useSendDmMessageMutation: mockedUseSendDmMessageMutation,
}));

const DirectMessagePanel = DirectMessagePanelModuleExport;

const workspaceId = 'ws-1';

function makeAgentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    workspaceId,
    name: 'ReportBot',
    agentIdentifier: 'report-bot@luminaos.internal',
    lifecycle: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDmMessageFixture(overrides: Partial<DmMessage> = {}): DmMessage {
  return {
    id: 'dm-1',
    workspaceId,
    userId: 'user-1',
    agentIdentifier: 'report-bot@luminaos.internal',
    sender: 'user',
    body: 'Merhaba ReportBot',
    proposalId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockAgentsQuery(
  data: { agents: Agent[] } | undefined,
  overrides: Partial<UseQueryResult<{ agents: Agent[] }>> = {},
): void {
  mockedUseAgentsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockDmMessagesQuery(
  data: { messages: DmMessage[] } | undefined,
  overrides: Partial<UseQueryResult<{ messages: DmMessage[] }>> = {},
): void {
  mockedUseDmMessagesQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockSendMutation(): { sendMutate: ReturnType<typeof vi.fn> } {
  const sendMutate = vi.fn();
  mockedUseSendDmMessageMutation.mockReturnValue({
    mutate: sendMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  });
  return { sendMutate };
}

function setupDefault(
  agents: Agent[],
  messages: DmMessage[] = [],
): { sendMutate: ReturnType<typeof vi.fn> } {
  mockAgentsQuery({ agents });
  mockDmMessagesQuery({ messages });
  return mockSendMutation();
}

async function selectAgent(user: ReturnType<typeof userEvent.setup>, agent: Agent): Promise<void> {
  await user.click(screen.getByTestId('dm-agent-picker'));
  await user.click(await screen.findByRole('option', { name: agent.name }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DirectMessagePanel', () => {
  it('renders a loading state (data-testid="dm-panel-loading") while the agents query is loading', () => {
    mockAgentsQuery(undefined, { isLoading: true });
    mockDmMessagesQuery(undefined);
    mockSendMutation();

    render(<DirectMessagePanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('dm-panel-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="dm-panel-error") when the agents query isError', () => {
    mockAgentsQuery(undefined, { isError: true, error: new Error('boom') });
    mockDmMessagesQuery(undefined);
    mockSendMutation();

    render(<DirectMessagePanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('dm-panel-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="dm-panel-empty") when there are zero agents to message', () => {
    setupDefault([]);

    render(<DirectMessagePanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('dm-panel-empty')).toBeInTheDocument();
  });

  it('renders an agent picker once agents are loaded, without any thread/composer until one is picked', () => {
    setupDefault([makeAgentFixture()]);

    render(<DirectMessagePanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('dm-agent-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('dm-composer-input')).not.toBeInTheDocument();
  });

  describe('agent selection', () => {
    it("selecting an agent in the picker calls useDmMessagesQuery with that agent's identifier", async () => {
      const agent = makeAgentFixture({
        id: 'agent-1',
        name: 'ReportBot',
        agentIdentifier: 'report-bot@luminaos.internal',
      });
      setupDefault([agent]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(mockedUseDmMessagesQuery).toHaveBeenCalledWith(workspaceId, agent.agentIdentifier);
    });

    it("selecting an agent in the picker calls useSendDmMessageMutation with that agent's identifier", async () => {
      const agent = makeAgentFixture({
        id: 'agent-1',
        name: 'ReportBot',
        agentIdentifier: 'report-bot@luminaos.internal',
      });
      setupDefault([agent]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(mockedUseSendDmMessageMutation).toHaveBeenCalledWith(
        workspaceId,
        agent.agentIdentifier,
      );
    });

    it('excludes deactivated agents from the picker options', async () => {
      const activeAgent = makeAgentFixture({ id: 'agent-1', name: 'ReportBot' });
      const deactivatedAgent = makeAgentFixture({
        id: 'agent-2',
        name: 'OldBot',
        lifecycle: 'deactivated',
      });
      setupDefault([activeAgent, deactivatedAgent]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await user.click(screen.getByTestId('dm-agent-picker'));

      expect(await screen.findByRole('option', { name: 'ReportBot' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'OldBot' })).not.toBeInTheDocument();
    });
  });

  describe('message thread (after an agent is selected)', () => {
    it('renders a thread loading state (data-testid="dm-thread-loading") while the dm messages query is loading', async () => {
      const agent = makeAgentFixture();
      mockAgentsQuery({ agents: [agent] });
      mockDmMessagesQuery(undefined, { isLoading: true });
      mockSendMutation();
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(screen.getByTestId('dm-thread-loading')).toBeInTheDocument();
    });

    it('renders a thread error state (data-testid="dm-thread-error") when the dm messages query isError', async () => {
      const agent = makeAgentFixture();
      mockAgentsQuery({ agents: [agent] });
      mockDmMessagesQuery(undefined, { isError: true, error: new Error('boom') });
      mockSendMutation();
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(screen.getByTestId('dm-thread-error')).toBeInTheDocument();
    });

    it('renders a thread empty state (data-testid="dm-thread-empty") with zero messages, but still renders the composer', async () => {
      const agent = makeAgentFixture();
      setupDefault([agent], []);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(screen.getByTestId('dm-thread-empty')).toBeInTheDocument();
      expect(screen.getByTestId('dm-composer-input')).toBeInTheDocument();
      expect(screen.getByTestId('dm-composer-submit')).toBeInTheDocument();
    });

    it('renders one row per message, in the same order as the data, each showing its body', async () => {
      const agent = makeAgentFixture();
      const first = makeDmMessageFixture({ id: 'dm-1', sender: 'user', body: 'İlk mesaj' });
      const second = makeDmMessageFixture({ id: 'dm-2', sender: 'agent', body: 'İkinci mesaj' });
      setupDefault([agent], [first, second]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      const rows = screen.getAllByTestId(/^dm-message-dm-\d$/);
      expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
        'dm-message-dm-1',
        'dm-message-dm-2',
      ]);
      expect(rows[0]).toHaveTextContent('İlk mesaj');
      expect(rows[1]).toHaveTextContent('İkinci mesaj');
    });

    it('prefixes an agent-sent message row with "Ajan: "', async () => {
      const agent = makeAgentFixture();
      const agentMessage = makeDmMessageFixture({
        id: 'dm-agent-1',
        sender: 'agent',
        body: 'Görevi kontrol ettim.',
      });
      setupDefault([agent], [agentMessage]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      const row = screen.getByTestId('dm-message-dm-agent-1');
      expect(row).toHaveTextContent('Ajan:');
      expect(row).toHaveTextContent('Görevi kontrol ettim.');
    });

    it('does NOT prefix a user-sent message row with "Ajan: "', async () => {
      const agent = makeAgentFixture();
      const userMessage = makeDmMessageFixture({
        id: 'dm-user-1',
        sender: 'user',
        body: 'Merhaba',
      });
      setupDefault([agent], [userMessage]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      const row = screen.getByTestId('dm-message-dm-user-1');
      expect(row.textContent).not.toContain('Ajan:');
    });
  });

  describe('reconfiguration proposal banner', () => {
    it('renders a proposal link anchor for an agent message with a non-null proposalId, pointing at #proposal-item-<proposalId>', async () => {
      const agent = makeAgentFixture();
      const message = makeDmMessageFixture({
        id: 'dm-3',
        sender: 'agent',
        proposalId: 'proposal-9',
        body: 'İzinlerinizi güncellememi ister misiniz?',
      });
      setupDefault([agent], [message]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      const link = screen.getByTestId('dm-proposal-link-dm-3');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '#proposal-item-proposal-9');
    });

    it('does NOT render a proposal link for an agent message with a null proposalId', async () => {
      const agent = makeAgentFixture();
      const message = makeDmMessageFixture({
        id: 'dm-4',
        sender: 'agent',
        proposalId: null,
        body: 'Görev tamamlandı.',
      });
      setupDefault([agent], [message]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(screen.queryByTestId('dm-proposal-link-dm-4')).not.toBeInTheDocument();
    });

    it('does NOT render a proposal link for a user-sent message even if proposalId happened to be non-null', async () => {
      const agent = makeAgentFixture();
      const message = makeDmMessageFixture({
        id: 'dm-5',
        sender: 'user',
        proposalId: 'proposal-9',
        body: 'İzinleri güncelle',
      });
      setupDefault([agent], [message]);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);

      expect(screen.queryByTestId('dm-proposal-link-dm-5')).not.toBeInTheDocument();
    });
  });

  describe('composer', () => {
    it('does not call the send mutation when submitting an empty/whitespace-only draft via the submit button', async () => {
      const agent = makeAgentFixture();
      const { sendMutate } = setupDefault([agent], []);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);
      await user.type(screen.getByTestId('dm-composer-input'), '   ');
      await user.click(screen.getByTestId('dm-composer-submit'));

      expect(sendMutate).not.toHaveBeenCalled();
    });

    it('calls the send mutation with the typed body when the submit button is clicked', async () => {
      const agent = makeAgentFixture();
      const { sendMutate } = setupDefault([agent], []);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);
      await user.type(screen.getByTestId('dm-composer-input'), 'Merhaba ReportBot');
      await user.click(screen.getByTestId('dm-composer-submit'));

      expect(sendMutate).toHaveBeenCalledWith('Merhaba ReportBot');
    });

    it('clears the composer draft after a successful send', async () => {
      const agent = makeAgentFixture();
      setupDefault([agent], []);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);
      const input = screen.getByTestId('dm-composer-input');
      await user.type(input, 'Merhaba ReportBot');
      await user.click(screen.getByTestId('dm-composer-submit'));

      expect(input).toHaveValue('');
    });

    it('pressing Enter (without Shift) inside the composer submits the draft', async () => {
      const agent = makeAgentFixture();
      const { sendMutate } = setupDefault([agent], []);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);
      await user.type(screen.getByTestId('dm-composer-input'), 'Merhaba ReportBot{Enter}');

      expect(sendMutate).toHaveBeenCalledWith('Merhaba ReportBot');
    });

    it('pressing Shift+Enter inside the composer does NOT submit -- it inserts a newline instead', async () => {
      const agent = makeAgentFixture();
      const { sendMutate } = setupDefault([agent], []);
      const user = userEvent.setup();

      render(<DirectMessagePanel workspaceId={workspaceId} />);
      await selectAgent(user, agent);
      const input = screen.getByTestId('dm-composer-input');
      await user.type(input, 'Birinci satır{Shift>}{Enter}{/Shift}İkinci satır');

      expect(sendMutate).not.toHaveBeenCalled();
      expect(input).toHaveValue('Birinci satır\nİkinci satır');
    });
  });
});
