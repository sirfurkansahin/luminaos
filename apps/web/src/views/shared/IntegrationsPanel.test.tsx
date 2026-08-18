import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntegrationsPanel } from './IntegrationsPanel.js';
import {
  useConnectIntegrationMutation,
  useDisconnectIntegrationMutation,
  useIntegrationsQuery,
} from '../../hooks/useIntegrationsQuery.js';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T10 PR1 — minimal "Entegrasyonlar" settings panel (ADR-0026 §c: mirrors
 * `MemoryPassportPanel`'s plain-JSX-sibling-in-App.tsx mounting convention,
 * no new router). Contract under test (not yet implemented --
 * `apps/web/src/views/shared/IntegrationsPanel.tsx` and
 * `apps/web/src/hooks/useIntegrationsQuery.ts` must be built to satisfy
 * these tests; that's the expected TDD red state):
 *
 *   export interface IntegrationConnectorStatus {
 *     connectorType: string;
 *     connected: boolean;
 *   }
 *
 *   export interface IntegrationsPanelProps { workspaceId: string; }
 *   export function IntegrationsPanel(props: IntegrationsPanelProps): React.JSX.Element;
 *
 *   // apps/web/src/hooks/useIntegrationsQuery.ts
 *   export function useIntegrationsQuery(workspaceId: string):
 *     UseQueryResult<{ connectors: IntegrationConnectorStatus[] }>;
 *   export function useConnectIntegrationMutation(workspaceId: string):
 *     UseMutationResult<{ authorizeUrl: string }, Error, string>; // variables: connectorType
 *   export function useDisconnectIntegrationMutation(workspaceId: string):
 *     UseMutationResult<void, Error, string>; // variables: connectorType
 *
 * - Since PR1 only builds a REAL Notion connector, the panel itself is
 *   CONNECTOR-AGNOSTIC (lists whatever `useIntegrationsQuery` reports, no
 *   Notion-specific branching in the panel's own logic) -- this file
 *   deliberately exercises the panel with a fixture connector list that
 *   includes types OTHER than "notion" too, to prove that.
 * - Four-state shape mirroring `MemoryPassportPanel`'s/`SavedViewsList`'s
 *   convention: isLoading -> data-testid="integrations-loading"; isError ->
 *   data-testid="integrations-error"; `data.connectors.length === 0` ->
 *   data-testid="integrations-empty"; otherwise -> one row per connector,
 *   data-testid=`integration-item-${connectorType}`.
 * - Each row shows a status affordance (data-testid=
 *   `integration-status-${connectorType}`) with a Turkish "Bağlı"/"Bağlı
 *   değil" label (this repo has no i18n catalog, hardcoded Turkish is the
 *   existing convention, see `MemoryPassportPanel`).
 * - A not-connected row shows a "Bağlan" button
 *   (data-testid=`integration-connect-${connectorType}`) and NO
 *   "Bağlantıyı Kes" button. Clicking it calls the connect mutation's
 *   `mutate` with the connectorType, passing an `onSuccess` callback (react-
 *   query's inline per-call options, mirrors `SaveViewButton`/
 *   `useObjectsQuery` call sites already using this pattern in this repo)
 *   that navigates the browser to the returned `authorizeUrl` via
 *   `window.location.assign(...)` (spied on in tests, never asserted via
 *   jsdom's real unimplemented navigation).
 * - A connected row shows a "Bağlantıyı Kes" button
 *   (data-testid=`integration-disconnect-${connectorType}`) and NO "Bağlan"
 *   button. Clicking it calls the disconnect mutation's `mutate` with the
 *   connectorType.
 * - Security invariant: the component sources identity ONLY from the
 *   `workspaceId` prop -- every hook is always called with exactly that
 *   value (mirrors `MemoryPassportPanel`'s identical invariant/test).
 *
 * `useIntegrationsQuery`/`useConnectIntegrationMutation`/
 * `useDisconnectIntegrationMutation` are mocked wholesale below, per this
 * repo's `MemoryPassportPanel.test.tsx` convention -- their own contract
 * would be pinned separately by a dedicated hook test file, not this one.
 */

vi.mock('../../hooks/useIntegrationsQuery.js', () => ({
  useIntegrationsQuery: vi.fn(),
  useConnectIntegrationMutation: vi.fn(),
  useDisconnectIntegrationMutation: vi.fn(),
}));

const mockedUseIntegrationsQuery = vi.mocked(useIntegrationsQuery);
const mockedUseConnectIntegrationMutation = vi.mocked(useConnectIntegrationMutation);
const mockedUseDisconnectIntegrationMutation = vi.mocked(useDisconnectIntegrationMutation);

const workspaceId = 'ws-1';

interface IntegrationConnectorStatus {
  connectorType: string;
  connected: boolean;
}

const FIXTURE_CONNECTORS: IntegrationConnectorStatus[] = [
  { connectorType: 'notion', connected: false },
  { connectorType: 'google-drive', connected: true },
  { connectorType: 'slack', connected: false },
];

function mockQuery(
  data: { connectors: IntegrationConnectorStatus[] } | undefined,
  overrides: Partial<UseQueryResult<{ connectors: IntegrationConnectorStatus[] }>> = {},
): void {
  mockedUseIntegrationsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as UseQueryResult<{ connectors: IntegrationConnectorStatus[] }>);
}

function makeMutationResultBase(
  mutate: (variables: never, options?: never) => void,
): Record<string, unknown> {
  return {
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  };
}

function mockMutations(): {
  connectMutate: ReturnType<typeof vi.fn>;
  disconnectMutate: ReturnType<typeof vi.fn>;
} {
  const connectMutate = vi.fn();
  const disconnectMutate = vi.fn();

  mockedUseConnectIntegrationMutation.mockReturnValue(
    makeMutationResultBase(connectMutate) as unknown as UseMutationResult<
      { authorizeUrl: string },
      Error,
      string
    >,
  );
  mockedUseDisconnectIntegrationMutation.mockReturnValue(
    makeMutationResultBase(disconnectMutate) as unknown as UseMutationResult<void, Error, string>,
  );

  return { connectMutate, disconnectMutate };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('IntegrationsPanel', () => {
  it('renders a loading state (data-testid="integrations-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integrations-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="integrations-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integrations-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="integrations-empty") when the backend reports zero connectors', () => {
    mockQuery({ connectors: [] });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integrations-empty')).toBeInTheDocument();
  });

  it('renders one row per connector the backend reports, including connector types OTHER than "notion" (connector-agnostic, no Notion-specific branching)', () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integration-item-notion')).toBeInTheDocument();
    expect(screen.getByTestId('integration-item-google-drive')).toBeInTheDocument();
    expect(screen.getByTestId('integration-item-slack')).toBeInTheDocument();
  });

  it('shows "Bağlı" for a connected connector and "Bağlı değil" for a not-connected one', () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integration-status-google-drive')).toHaveTextContent('Bağlı');
    expect(screen.getByTestId('integration-status-notion')).toHaveTextContent('Bağlı değil');
  });

  it('a not-connected connector shows a "Bağlan" button and NO "Bağlantıyı Kes" button', () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integration-connect-notion')).toBeInTheDocument();
    expect(screen.queryByTestId('integration-disconnect-notion')).not.toBeInTheDocument();
  });

  it('a connected connector shows a "Bağlantıyı Kes" button and NO "Bağlan" button', () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('integration-disconnect-google-drive')).toBeInTheDocument();
    expect(screen.queryByTestId('integration-connect-google-drive')).not.toBeInTheDocument();
  });

  it('clicking "Bağlan" calls the connect mutation\'s mutate with the connectorType', async () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    const { connectMutate } = mockMutations();
    const user = userEvent.setup();

    render(<IntegrationsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('integration-connect-notion'));

    expect(connectMutate).toHaveBeenCalledTimes(1);
    const [connectorTypeArg] = connectMutate.mock.calls[0] as [string, ...unknown[]];
    expect(connectorTypeArg).toBe('notion');
  });

  it('clicking "Bağlan" navigates the browser to the authorizeUrl returned by the connect mutation\'s onSuccess', async () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    const { connectMutate } = mockMutations();
    const user = userEvent.setup();
    const assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {
      /* no-op: never let jsdom actually attempt navigation */
    });

    render(<IntegrationsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('integration-connect-notion'));

    // Simulate react-query invoking the per-call `onSuccess` option this
    // component passed as `mutate`'s second argument.
    const [, options] = connectMutate.mock.calls[0] as [
      string,
      { onSuccess?: (data: { authorizeUrl: string }) => void } | undefined,
    ];
    options?.onSuccess?.({ authorizeUrl: 'https://mcp.notion.com/oauth/authorize?fixture=1' });

    expect(assignSpy).toHaveBeenCalledWith('https://mcp.notion.com/oauth/authorize?fixture=1');
  });

  it('clicking "Bağlantıyı Kes" calls the disconnect mutation\'s mutate with the connectorType', async () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    const { disconnectMutate } = mockMutations();
    const user = userEvent.setup();

    render(<IntegrationsPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('integration-disconnect-google-drive'));

    expect(disconnectMutate).toHaveBeenCalledWith('google-drive');
  });

  it('sources identity only from the workspaceId prop — every hook is called with exactly that value', () => {
    mockQuery({ connectors: FIXTURE_CONNECTORS });
    mockMutations();

    render(<IntegrationsPanel workspaceId={workspaceId} />);

    expect(mockedUseIntegrationsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseConnectIntegrationMutation).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseDisconnectIntegrationMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [
      mockedUseIntegrationsQuery,
      mockedUseConnectIntegrationMutation,
      mockedUseDisconnectIntegrationMutation,
    ]) {
      for (const call of mockedHook.mock.calls) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});
