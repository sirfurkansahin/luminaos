import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDirectoryPanel as AgentDirectoryPanelModuleExport } from './AgentDirectoryPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T3 PR7a (ADR-0037 §b/§d) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/views/shared/AgentDirectoryPanel.tsx to satisfy these tests):
 *
 *   export interface AgentDirectoryPanelProps { workspaceId: string; }
 *   export function AgentDirectoryPanel(props: AgentDirectoryPanelProps): React.JSX.Element;
 *
 * Combines `AutomationHistoryPanel.tsx`'s plain-list-no-dialog top-level
 * states (loading/error/empty, each with its own data-testid) with
 * `McpAccessPanel.tsx`'s inline (non-dialog, per this task's spec) register
 * form + mutate(vars, { onSuccess }) draft-clear-on-success convention.
 *
 * States, keyed off `useAgentsQuery(workspaceId)`'s `{ data, isLoading,
 * isError }`:
 *   - isLoading -> data-testid="agent-directory-loading"
 *   - isError -> data-testid="agent-directory-error" (a `@luminaos/ui`
 *     `EmptyState`, Turkish copy)
 *   - zero ACTIVE agents (data.agents filtered to lifecycle === 'active') ->
 *     data-testid="agent-directory-empty" (a `@luminaos/ui` `EmptyState`,
 *     Turkish copy) -- a `deactivated` agent alone also counts as "zero
 *     active agents".
 *   - otherwise -> `<ul aria-label="Ajanlar">`, one `<li data-testid=
 *     "agent-item-<id>">` PER ACTIVE agent only (deactivated agents are
 *     filtered out of this list entirely, never rendered), each row's text
 *     content includes the agent's `name` and `agentIdentifier`.
 *
 * A register form is ALWAYS rendered (independent of the above list states,
 * mirrors McpAccessPanel's create form being reachable regardless of the
 * list's own state) with:
 *   - `@luminaos/ui` `Input` data-testid="agent-directory-name-input"
 *   - `@luminaos/ui` `Input` data-testid="agent-directory-identifier-input"
 *   - `@luminaos/ui` `Button` data-testid="agent-directory-register-button",
 *     Turkish label containing "Kaydet"
 *
 * Submitting (clicking the register button) with BOTH fields non-empty/
 * non-whitespace calls `useRegisterAgentMutation(workspaceId)`'s `mutate`
 * with EXACTLY `{ name: <trimmed name>, agentIdentifier: <trimmed
 * identifier> }` as the first argument, passing an inline `onSuccess`
 * callback (mirrors McpAccessPanel.tsx's `createMutation.mutate(vars, {
 * onSuccess: ... })` call-site pattern) that clears BOTH inputs back to ''.
 * Submitting with either field empty/whitespace-only is a no-op (mutate is
 * NOT called, inputs are left as-is) -- mirrors ChecklistWidget's own
 * non-empty-text guard.
 *
 * `useAgentsQuery`/`useRegisterAgentMutation`
 * (../../hooks/useAgentsQuery.ts) do not exist yet, so — mirroring
 * `AutomationHistoryPanel.test.tsx`'s handling of the equally-not-yet-existing
 * `useProposalsQuery` hooks — mock functions are created via `vi.hoisted` and
 * referenced ONLY by closure inside the `vi.mock` factory below; this file
 * never imports that hook module itself. The `Agent` shape is declared
 * locally for the same reason. `./AgentDirectoryPanel.tsx` itself DOES NOT
 * exist yet either — imported directly (`ModuleExport` cast), so this test
 * file is expected to fail to even resolve that import until the component
 * exists — the documented TDD red state.
 */

interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: string;
}

const { mockedUseAgentsQuery, mockedUseRegisterAgentMutation } = vi.hoisted(() => {
  return {
    mockedUseAgentsQuery: vi.fn(),
    mockedUseRegisterAgentMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useAgentsQuery.js', () => ({
  useAgentsQuery: mockedUseAgentsQuery,
  useRegisterAgentMutation: mockedUseRegisterAgentMutation,
}));

const AgentDirectoryPanel = AgentDirectoryPanelModuleExport;

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

function mockQuery(
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

function mockRegisterMutation(): { registerMutate: ReturnType<typeof vi.fn> } {
  const registerMutate = vi.fn();
  mockedUseRegisterAgentMutation.mockReturnValue({
    mutate: registerMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  });
  return { registerMutate };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentDirectoryPanel', () => {
  it('renders a loading state (data-testid="agent-directory-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('agent-directory-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="agent-directory-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('agent-directory-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="agent-directory-empty") when there are zero agents', () => {
    mockQuery({ agents: [] });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('agent-directory-empty')).toBeInTheDocument();
  });

  it('renders an empty state when the only agent present is deactivated', () => {
    mockQuery({ agents: [makeAgentFixture({ id: 'agent-old', lifecycle: 'deactivated' })] });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('agent-directory-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-item-agent-old')).not.toBeInTheDocument();
  });

  it('renders one row per ACTIVE agent, showing its name and agentIdentifier', () => {
    const agent = makeAgentFixture({
      id: 'agent-1',
      name: 'ReportBot',
      agentIdentifier: 'report-bot@luminaos.internal',
    });
    mockQuery({ agents: [agent] });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('agent-item-agent-1');
    expect(row).toHaveTextContent('ReportBot');
    expect(row).toHaveTextContent('report-bot@luminaos.internal');
  });

  it('filters out deactivated agents from the rendered list, keeping only active ones', () => {
    const active = makeAgentFixture({ id: 'agent-active', lifecycle: 'active' });
    const deactivated = makeAgentFixture({ id: 'agent-deactivated', lifecycle: 'deactivated' });
    mockQuery({ agents: [active, deactivated] });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('agent-item-agent-active')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-item-agent-deactivated')).not.toBeInTheDocument();
  });

  it('always renders the register form (name input, identifier input, register button)', () => {
    mockQuery({ agents: [] });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('agent-directory-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('agent-directory-identifier-input')).toBeInTheDocument();
    expect(screen.getByTestId('agent-directory-register-button')).toBeInTheDocument();
  });

  it('does not call the register mutation when submitting with an empty name', async () => {
    mockQuery({ agents: [] });
    const { registerMutate } = mockRegisterMutation();
    const user = userEvent.setup();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('agent-directory-identifier-input'), 'report-bot@x.dev');
    await user.click(screen.getByTestId('agent-directory-register-button'));

    expect(registerMutate).not.toHaveBeenCalled();
  });

  it('does not call the register mutation when submitting with an empty identifier', async () => {
    mockQuery({ agents: [] });
    const { registerMutate } = mockRegisterMutation();
    const user = userEvent.setup();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('agent-directory-name-input'), 'ReportBot');
    await user.click(screen.getByTestId('agent-directory-register-button'));

    expect(registerMutate).not.toHaveBeenCalled();
  });

  it('submitting with both fields filled calls the register mutation with { name, agentIdentifier }', async () => {
    mockQuery({ agents: [] });
    const { registerMutate } = mockRegisterMutation();
    const user = userEvent.setup();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('agent-directory-name-input'), 'ReportBot');
    await user.type(
      screen.getByTestId('agent-directory-identifier-input'),
      'report-bot@luminaos.internal',
    );
    await user.click(screen.getByTestId('agent-directory-register-button'));

    expect(registerMutate).toHaveBeenCalledTimes(1);
    const [variables] = registerMutate.mock.calls[0] as [
      { name: string; agentIdentifier: string },
      ...unknown[],
    ];
    expect(variables).toEqual({
      name: 'ReportBot',
      agentIdentifier: 'report-bot@luminaos.internal',
    });
  });

  it('clears both inputs once the register mutation succeeds', async () => {
    mockQuery({ agents: [] });
    const { registerMutate } = mockRegisterMutation();
    const user = userEvent.setup();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('agent-directory-name-input'), 'ReportBot');
    await user.type(
      screen.getByTestId('agent-directory-identifier-input'),
      'report-bot@luminaos.internal',
    );
    await user.click(screen.getByTestId('agent-directory-register-button'));

    const [, options] = registerMutate.mock.calls[0] as [
      unknown,
      { onSuccess?: (data: { agent: Agent }) => void } | undefined,
    ];
    options?.onSuccess?.({ agent: makeAgentFixture({ id: 'agent-new' }) });

    expect(screen.getByTestId('agent-directory-name-input')).toHaveValue('');
    expect(screen.getByTestId('agent-directory-identifier-input')).toHaveValue('');
  });

  it('sources identity only from the workspaceId prop -- every hook is called with exactly that value', () => {
    mockQuery({ agents: [] });
    mockRegisterMutation();

    render(<AgentDirectoryPanel workspaceId={workspaceId} />);

    expect(mockedUseAgentsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseRegisterAgentMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [mockedUseAgentsQuery, mockedUseRegisterAgentMutation]) {
      for (const call of mockedHook.mock.calls as unknown[][]) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});
