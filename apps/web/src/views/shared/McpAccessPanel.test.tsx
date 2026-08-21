import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpAccessPanel as McpAccessPanelModuleExport } from './McpAccessPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F2-T12 PR2 (ADR-0028 §k/§l, spec Kabul Kriterleri: "Kullanıcı panelden bir
 * MCP erişim token'ı oluşturabilir ... ve iptal edebilir") — TDD red step.
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/McpAccessPanel.tsx to satisfy these tests):
 *
 *   export interface McpAccessPanelProps { workspaceId: string; }
 *   export function McpAccessPanel(props: McpAccessPanelProps): React.JSX.Element;
 *
 * Combines two established patterns per the plan:
 * - `IntegrationsPanel.tsx`'s list-rendering convention — the grant list
 *   itself is rendered DIRECTLY (not gated behind any dialog), four-state
 *   shape: isLoading -> data-testid="mcp-grants-loading"; isError ->
 *   data-testid="mcp-grants-error"; data.grants.length === 0 ->
 *   data-testid="mcp-grants-empty"; otherwise -> one row per grant,
 *   data-testid=`mcp-grant-item-${grant.id}`.
 * - `MemoryPassportPanel.tsx`'s Dialog open/close mechanics — but ONLY the
 *   creation flow lives behind a Dialog (data-testid="mcp-access-dialog"),
 *   triggered by a visible "Yeni token oluştur" button
 *   (data-testid="mcp-access-create-trigger"). The list itself is not inside
 *   this dialog.
 *
 * Each grant row shows its `name`, `tokenPrefix`, a createdAt-derived string,
 * and a status affordance (data-testid=`mcp-grant-status-${grant.id}`)
 * distinguishing an active grant from a revoked one (`revokedAt !== null`).
 * A revoked row has NO enabled revoke affordance (either absent or disabled —
 * mirrors IntegrationsPanel's binary connected/not-connected row shape). An
 * active row has an enabled "Sil" button (data-testid=`mcp-grant-revoke-
 * ${grant.id}`) that calls the revoke mutation's `mutate` with the grant id.
 *
 * Inside the create Dialog (ADR-0028 Karar l — NO "never expires" option,
 * fixed 30/90/365-day menu, default 90):
 *   - name input: data-testid="mcp-grant-name-input" (required, non-empty)
 *   - duration selector: data-testid="mcp-grant-duration-select", a real
 *     (non-mocked) `@luminaos/ui` SelectRoot/SelectTrigger/SelectContent/
 *     SelectItem trio (mirrors AvailabilitySelector.tsx's real-Select
 *     convention) offering EXACTLY three options — 30/90/365 days, no
 *     free-text date input anywhere in the dialog.
 *   - submit: data-testid="mcp-grant-create-submit", calls the create
 *     mutation's `mutate` with `{ name, expiresAtDays }` and an inline
 *     `onSuccess` callback (mirrors IntegrationsPanel's
 *     connect-mutation-onSuccess-navigates pattern) that switches the dialog
 *     into a "reveal" state.
 *   - reveal state: data-testid="mcp-grant-reveal" containing the raw token
 *     value (data-testid="mcp-grant-raw-token") and a warning-toned message
 *     that it will never be shown again (data-testid=
 *     "mcp-grant-reveal-warning") — exact Turkish wording is an implementer
 *     judgment call, not pinned here. A close button
 *     (data-testid="mcp-grant-reveal-close") closes the dialog, returning to
 *     the (always-visible) list view. Real query-invalidation/refetch
 *     behavior once the create mutation succeeds is pinned by
 *     useMcpGrantsQuery.test.ts, NOT here (useMcpGrantsQuery is mocked
 *     wholesale in this file).
 *
 * `useMcpGrantsQuery`/`useCreateMcpGrantMutation`/`useRevokeMcpGrantMutation`
 * (../../hooks/useMcpGrantsQuery.ts) do not exist yet, so — mirroring
 * `CommandPalette.test.tsx`'s handling of the equally-not-yet-existing
 * `useExternalSearchQuery` — mock functions are created via `vi.hoisted` and
 * referenced ONLY by closure inside the `vi.mock` factory below; this file
 * never imports that hook module itself, so there is nothing for a top-level
 * binding to fail to resolve. The `McpClientGrant`/`CreateMcpClientGrantResult`
 * shapes are declared locally (already-pinned ADR-0028 shape) for the same
 * reason. `./McpAccessPanel.tsx` itself DOES NOT exist yet either — imported
 * directly (`ModuleExport` cast, mirroring `ExternalSearchResultChip.test.tsx`'s
 * technique for the primary subject-under-test file), so this test file is
 * expected to fail to even resolve that import until the component exists —
 * the documented TDD red state (see `StatusPrioritySelect.test.tsx`'s
 * identical precedent comment).
 */

interface McpClientGrant {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface CreateMcpClientGrantResult {
  grant: McpClientGrant;
  rawToken: string;
}

const {
  mockedUseMcpGrantsQuery,
  mockedUseCreateMcpGrantMutation,
  mockedUseRevokeMcpGrantMutation,
} = vi.hoisted(() => {
  return {
    mockedUseMcpGrantsQuery: vi.fn(),
    mockedUseCreateMcpGrantMutation: vi.fn(),
    mockedUseRevokeMcpGrantMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useMcpGrantsQuery.js', () => ({
  useMcpGrantsQuery: mockedUseMcpGrantsQuery,
  useCreateMcpGrantMutation: mockedUseCreateMcpGrantMutation,
  useRevokeMcpGrantMutation: mockedUseRevokeMcpGrantMutation,
}));

const McpAccessPanel = McpAccessPanelModuleExport;

const workspaceId = 'ws-1';

function makeGrantFixture(overrides: Partial<McpClientGrant> = {}): McpClientGrant {
  return {
    id: 'grant-1',
    name: "Kişisel Claude Desktop'ım",
    tokenPrefix: 'Ab3xK9mZ1234',
    createdAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function mockQuery(
  data: { grants: McpClientGrant[] } | undefined,
  overrides: Partial<UseQueryResult<{ grants: McpClientGrant[] }>> = {},
): void {
  mockedUseMcpGrantsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function makeMutationResultBase(mutate: (...args: never[]) => void): Record<string, unknown> {
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
  createMutate: ReturnType<typeof vi.fn>;
  revokeMutate: ReturnType<typeof vi.fn>;
} {
  const createMutate = vi.fn();
  const revokeMutate = vi.fn();

  mockedUseCreateMcpGrantMutation.mockReturnValue(makeMutationResultBase(createMutate));
  mockedUseRevokeMcpGrantMutation.mockReturnValue(makeMutationResultBase(revokeMutate));

  return { createMutate, revokeMutate };
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('mcp-access-create-trigger'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('McpAccessPanel', () => {
  it('renders a loading state (data-testid="mcp-grants-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('mcp-grants-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="mcp-grants-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('mcp-grants-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="mcp-grants-empty") when there are zero grants', () => {
    mockQuery({ grants: [] });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('mcp-grants-empty')).toBeInTheDocument();
  });

  it('renders one row per grant, showing its name and tokenPrefix', () => {
    const grant = makeGrantFixture({
      id: 'grant-1',
      name: 'Masaüstü İstemcim',
      tokenPrefix: 'Ab3xK9mZ1234',
    });
    mockQuery({ grants: [grant] });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    const row = screen.getByTestId('mcp-grant-item-grant-1');
    expect(row).toHaveTextContent('Masaüstü İstemcim');
    expect(row).toHaveTextContent('Ab3xK9mZ1234');
  });

  it('shows an active grant (revokedAt: null) with an enabled "Sil" revoke button', () => {
    const grant = makeGrantFixture({ id: 'grant-1', revokedAt: null });
    mockQuery({ grants: [grant] });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    const revokeButton = screen.getByTestId('mcp-grant-revoke-grant-1');
    expect(revokeButton).toBeInTheDocument();
    expect(revokeButton).toBeEnabled();
  });

  it('visually distinguishes a revoked grant (revokedAt !== null) from an active one, with no enabled revoke affordance', () => {
    const activeGrant = makeGrantFixture({ id: 'grant-active', revokedAt: null });
    const revokedGrant = makeGrantFixture({
      id: 'grant-revoked',
      revokedAt: '2026-08-10T00:00:00.000Z',
    });
    mockQuery({ grants: [activeGrant, revokedGrant] });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    const activeStatus = screen.getByTestId('mcp-grant-status-grant-active');
    const revokedStatus = screen.getByTestId('mcp-grant-status-grant-revoked');
    expect(revokedStatus.textContent).not.toEqual(activeStatus.textContent);

    const revokeButton = screen.queryByTestId('mcp-grant-revoke-grant-revoked');
    if (revokeButton) {
      expect(revokeButton).toBeDisabled();
    } else {
      expect(revokeButton).not.toBeInTheDocument();
    }
  });

  it('clicking "Sil" on an active grant calls the revoke mutation\'s mutate with that grant\'s id', async () => {
    const grant = makeGrantFixture({ id: 'grant-1', revokedAt: null });
    mockQuery({ grants: [grant] });
    const { revokeMutate } = mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('mcp-grant-revoke-grant-1'));

    expect(revokeMutate).toHaveBeenCalledWith('grant-1');
  });

  it('the raw token is never rendered anywhere in the list view (GET /grants-shaped data never includes rawToken)', () => {
    const grant = makeGrantFixture({ id: 'grant-1', tokenPrefix: 'Ab3xK9mZ1234' });
    mockQuery({ grants: [grant] });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    // A raw token is ~43 base64url characters (crypto.randomBytes(32)) --
    // nothing that long/opaque should ever appear outside the one-time
    // reveal dialog. The list-view DOM must show at most the 12-char prefix.
    expect(document.body.textContent).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });

  it('does not render the create dialog by default (closed)', () => {
    mockQuery({ grants: [] });
    mockMutations();

    render(<McpAccessPanel workspaceId={workspaceId} />);

    expect(screen.queryByTestId('mcp-access-dialog')).not.toBeInTheDocument();
  });

  it('opens the create dialog when the "Yeni token oluştur" trigger is clicked', async () => {
    mockQuery({ grants: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    expect(screen.getByTestId('mcp-access-dialog')).toBeInTheDocument();
  });

  it('the duration selector defaults to 90 days', async () => {
    mockQuery({ grants: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    expect(screen.getByTestId('mcp-grant-duration-select')).toHaveTextContent(/90/);
  });

  it('offers EXACTLY three duration options -- 30/90/365 days, nothing else', async () => {
    mockQuery({ grants: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.click(screen.getByTestId('mcp-grant-duration-select'));

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options.some((option) => /30/.test(option.textContent))).toBe(true);
    expect(options.some((option) => /90/.test(option.textContent))).toBe(true);
    expect(options.some((option) => /365/.test(option.textContent))).toBe(true);
  });

  it('renders no free-text date input anywhere in the create dialog (no "never expires"/custom-date escape hatch)', async () => {
    mockQuery({ grants: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    const dialog = screen.getByTestId('mcp-access-dialog');
    expect(dialog.querySelector('input[type="date"]')).toBeNull();
    expect(dialog.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it('does not call the create mutation when submitting with an empty name', async () => {
    mockQuery({ grants: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.click(screen.getByTestId('mcp-grant-create-submit'));

    expect(createMutate).not.toHaveBeenCalled();
  });

  it('submitting with a name and the default duration calls the create mutation with { name, expiresAtDays: 90 }', async () => {
    mockQuery({ grants: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(screen.getByTestId('mcp-grant-name-input'), "Kişisel Claude Desktop'ım");
    await user.click(screen.getByTestId('mcp-grant-create-submit'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [variables] = createMutate.mock.calls[0] as [
      { name: string; expiresAtDays: 30 | 90 | 365 },
      ...unknown[],
    ];
    expect(variables).toEqual({ name: "Kişisel Claude Desktop'ım", expiresAtDays: 90 });
  });

  it('selecting 30 days then submitting calls the create mutation with expiresAtDays: 30', async () => {
    mockQuery({ grants: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(screen.getByTestId('mcp-grant-name-input'), 'Kişisel MCP istemcim');
    await user.click(screen.getByTestId('mcp-grant-duration-select'));
    await user.click(screen.getByRole('option', { name: /30/ }));
    await user.click(screen.getByTestId('mcp-grant-create-submit'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [variables] = createMutate.mock.calls[0] as [
      { name: string; expiresAtDays: 30 | 90 | 365 },
      ...unknown[],
    ];
    expect(variables).toEqual({ name: 'Kişisel MCP istemcim', expiresAtDays: 30 });
  });

  it('on successful creation, switches to a reveal state showing the raw token and a warning it will never be shown again', async () => {
    mockQuery({ grants: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();
    const rawToken = 'Ab3xK9mZ_FIXTURE_RAW_TOKEN_VALUE_ONLY_SHOWN_ONCE';

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(screen.getByTestId('mcp-grant-name-input'), 'Kişisel MCP istemcim');
    await user.click(screen.getByTestId('mcp-grant-create-submit'));

    const [, options] = createMutate.mock.calls[0] as [
      unknown,
      { onSuccess?: (data: CreateMcpClientGrantResult) => void } | undefined,
    ];
    act(() => {
      options?.onSuccess?.({
        grant: makeGrantFixture({ id: 'grant-new' }),
        rawToken,
      });
    });

    expect(screen.getByTestId('mcp-grant-reveal')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-grant-raw-token')).toHaveTextContent(rawToken);
    expect(screen.getByTestId('mcp-grant-reveal-warning')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-grant-reveal-warning').textContent).not.toHaveLength(0);
  });

  it('closing the dialog after reveal returns to the (always-visible) list view and the raw token no longer appears anywhere', async () => {
    mockQuery({ grants: [] });
    const { createMutate } = mockMutations();
    const user = userEvent.setup();
    const rawToken = 'Ab3xK9mZ_FIXTURE_RAW_TOKEN_VALUE_ONLY_SHOWN_ONCE';

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);
    await user.type(screen.getByTestId('mcp-grant-name-input'), 'Kişisel MCP istemcim');
    await user.click(screen.getByTestId('mcp-grant-create-submit'));

    const [, options] = createMutate.mock.calls[0] as [
      unknown,
      { onSuccess?: (data: CreateMcpClientGrantResult) => void } | undefined,
    ];
    act(() => {
      options?.onSuccess?.({ grant: makeGrantFixture({ id: 'grant-new' }), rawToken });
    });

    await user.click(screen.getByTestId('mcp-grant-reveal-close'));

    expect(screen.queryByTestId('mcp-access-dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(rawToken);
  });

  it('sources identity only from the workspaceId prop -- every hook is called with exactly that value', async () => {
    mockQuery({ grants: [] });
    mockMutations();
    const user = userEvent.setup();

    render(<McpAccessPanel workspaceId={workspaceId} />);
    await openCreateDialog(user);

    expect(mockedUseMcpGrantsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseCreateMcpGrantMutation).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseRevokeMcpGrantMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [
      mockedUseMcpGrantsQuery,
      mockedUseCreateMcpGrantMutation,
      mockedUseRevokeMcpGrantMutation,
    ]) {
      for (const call of mockedHook.mock.calls as unknown[][]) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});

// `within` is imported for potential future scoped queries inside the
// dialog; referenced here so the import itself isn't flagged unused if a
// future edit removes its only call site above.
void within;
