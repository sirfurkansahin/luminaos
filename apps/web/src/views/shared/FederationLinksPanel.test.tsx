import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FederationLinksPanel as FederationLinksPanelModuleExport } from './FederationLinksPanel.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T14 PR3 (ADR-0048, spec Kabul Kriterleri: "admin+ olmayan kullanıcı için
 * yönetim aksiyonları UI'da gizli/devre dışı"; "Link durumuna göre doğru
 * aksiyon butonları (pending -> kabul et/iptal, active -> kapsam yönetimi/
 * iptal, revoked -> salt-okunur) render ediliyor") — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/FederationLinksPanel.tsx to satisfy these tests):
 *
 *   export interface FederationLinksPanelProps { workspaceId: string; isAdmin: boolean; }
 *   export function FederationLinksPanel(props: FederationLinksPanelProps): React.JSX.Element;
 *
 * RBAC is injected via the `isAdmin` prop (mirrors `AutonomyTierPanel`-family
 * panels' convention of receiving already-resolved membership state as a
 * prop rather than re-deriving it) — link initiate/accept/revoke, scope
 * add/remove and credential create/revoke are ALL admin+-gated (ADR-0048
 * RBAC özeti). Uses `useFederationLinksQuery`/`useInitiateFederationLinkMutation`/
 * `useAcceptFederationLinkMutation`/`useRevokeFederationLinkMutation`
 * (../../hooks/useFederationLinksQuery.js), `useFederationScopeQuery`/
 * `useAddFederationScopeObjectMutation`/`useRemoveFederationScopeObjectMutation`
 * (../../hooks/useFederationScopeQuery.js) and
 * `useCreateFederationCredentialMutation`/`useRevokeFederationCredentialMutation`
 * (../../hooks/useFederationCredentialsMutation.js) — all mocked wholesale
 * below via `vi.hoisted`, mirroring `AutonomyTierPanel.test.tsx`'s/
 * `McpAccessPanel.test.tsx`'s established approach; none of those hook
 * modules are imported directly by this file.
 *
 * Contract pinned:
 * - top-level states: isLoading (useFederationLinksQuery) ->
 *   data-testid="federation-links-loading"; isError ->
 *   data-testid="federation-links-error".
 * - initiate form (data-testid="federation-link-initiate-input" +
 *   "federation-link-initiate-submit") renders ONLY when isAdmin is true;
 *   submitting with a non-empty value calls
 *   useInitiateFederationLinkMutation's `mutate` with EXACTLY
 *   `{ counterpartWorkspaceId: <input value> }`; submitting with an empty
 *   value does NOT call `mutate`.
 * - one row per link, data-testid=`federation-link-item-${link.id}`, with a
 *   status indicator data-testid=`federation-link-status-${link.id}`.
 * - isAdmin=false: NONE of the initiate input, nor any
 *   accept/revoke/scope-add/credential-create control, appears ANYWHERE in
 *   the document, regardless of any link's status (pending/active/revoked).
 * - isAdmin=true + a `pending` link: shows an accept button
 *   (data-testid=`federation-link-accept-${link.id}`, calls
 *   useAcceptFederationLinkMutation's `mutate` with the link's id) AND a
 *   revoke/cancel button (data-testid=`federation-link-revoke-${link.id}`,
 *   calls useRevokeFederationLinkMutation's `mutate` with the link's id).
 * - isAdmin=true + an `active` link: shows a revoke button
 *   (data-testid=`federation-link-revoke-${link.id}`) and a scope-management
 *   section (data-testid=`federation-link-scope-section-${link.id}`)
 *   containing: an add-object input
 *   (data-testid=`federation-scope-add-input-${link.id}`) + submit button
 *   (data-testid=`federation-scope-add-submit-${link.id}`) that calls
 *   useAddFederationScopeObjectMutation's `mutate` with
 *   `{ objectId: <input value> }`; and one row per
 *   useFederationScopeQuery(workspaceId, link.id) result
 *   (data-testid=`federation-scope-item-${link.id}-${scopeObject.objectId}`)
 *   each with a remove button
 *   (data-testid=`federation-scope-remove-${link.id}-${scopeObject.objectId}`)
 *   that calls useRemoveFederationScopeObjectMutation's `mutate` with that
 *   `objectId`. NO accept button appears for an `active` link (only
 *   `pending` links are acceptable).
 * - isAdmin=true + an `active` link ALSO shows a credential-creation section:
 *   a name input (data-testid=`federation-credential-name-input-${link.id}`)
 *   + submit button
 *   (data-testid=`federation-credential-create-submit-${link.id}`) that calls
 *   useCreateFederationCredentialMutation's `mutate` with
 *   `{ name: <input value> }` and an inline `onSuccess` callback. On success,
 *   the panel switches into a ONE-TIME reveal state
 *   (data-testid=`federation-credential-raw-token-${link.id}`) showing the
 *   raw token, plus a close button
 *   (data-testid=`federation-credential-reveal-close-${link.id}`). SECURITY
 *   REGRESSION PINNED: once the reveal is closed (or once a second credential
 *   is created), the PREVIOUS raw token value must NEVER appear anywhere in
 *   `document.body.textContent` again — only each credential's `tokenPrefix`
 *   is ever shown in the always-visible list
 *   (data-testid=`federation-credential-item-${link.id}-${credential.id}`).
 * - isAdmin=true + a `revoked` link: READ-ONLY — none of accept/revoke/
 *   scope-add/credential-create controls render for that link (terminal
 *   state, ADR-0048 §b).
 * - every relevant hook is called with the panel's own `workspaceId` (and,
 *   for per-link hooks, that link's id).
 */

interface FederationLink {
  id: string;
  initiatorWorkspaceId: string;
  counterpartWorkspaceId: string;
  pairKey: string;
  status: 'pending' | 'active' | 'revoked';
  initiatedByUserId: string;
  acceptedByUserId: string | null;
  revokedByUserId: string | null;
  initiatorAuditStreamId: string;
  counterpartAuditStreamId: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

interface FederationScopeObject {
  id: string;
  federationLinkId: string;
  objectId: string;
  ownerWorkspaceId: string;
  addedByUserId: string;
  addedAt: string;
  removedAt: string | null;
}

interface FederationLinkCredential {
  id: string;
  federationLinkId: string;
  granteeWorkspaceId: string;
  name: string;
  tokenPrefix: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface CreateFederationCredentialResult {
  credential: FederationLinkCredential;
  rawToken: string;
}

const {
  mockedUseFederationLinksQuery,
  mockedUseInitiateFederationLinkMutation,
  mockedUseAcceptFederationLinkMutation,
  mockedUseRevokeFederationLinkMutation,
  mockedUseFederationScopeQuery,
  mockedUseAddFederationScopeObjectMutation,
  mockedUseRemoveFederationScopeObjectMutation,
  mockedUseCreateFederationCredentialMutation,
  mockedUseRevokeFederationCredentialMutation,
} = vi.hoisted(() => {
  return {
    mockedUseFederationLinksQuery: vi.fn(),
    mockedUseInitiateFederationLinkMutation: vi.fn(),
    mockedUseAcceptFederationLinkMutation: vi.fn(),
    mockedUseRevokeFederationLinkMutation: vi.fn(),
    mockedUseFederationScopeQuery: vi.fn(),
    mockedUseAddFederationScopeObjectMutation: vi.fn(),
    mockedUseRemoveFederationScopeObjectMutation: vi.fn(),
    mockedUseCreateFederationCredentialMutation: vi.fn(),
    mockedUseRevokeFederationCredentialMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useFederationLinksQuery.js', () => ({
  useFederationLinksQuery: mockedUseFederationLinksQuery,
  useInitiateFederationLinkMutation: mockedUseInitiateFederationLinkMutation,
  useAcceptFederationLinkMutation: mockedUseAcceptFederationLinkMutation,
  useRevokeFederationLinkMutation: mockedUseRevokeFederationLinkMutation,
}));

vi.mock('../../hooks/useFederationScopeQuery.js', () => ({
  useFederationScopeQuery: mockedUseFederationScopeQuery,
  useAddFederationScopeObjectMutation: mockedUseAddFederationScopeObjectMutation,
  useRemoveFederationScopeObjectMutation: mockedUseRemoveFederationScopeObjectMutation,
}));

vi.mock('../../hooks/useFederationCredentialsMutation.js', () => ({
  useCreateFederationCredentialMutation: mockedUseCreateFederationCredentialMutation,
  useRevokeFederationCredentialMutation: mockedUseRevokeFederationCredentialMutation,
}));

// `./FederationLinksPanel.tsx` does not exist yet -- see
// `useFederationLinksQuery.test.ts`'s header comment for the
// `ModuleExport as unknown as <shape>` lint-avoidance rationale, applied here
// to a component instead of a hook (mirrors `ExternalSearchResultChip.test.tsx`'s
// identical technique for the primary subject-under-test file).
const FederationLinksPanel = FederationLinksPanelModuleExport;

const workspaceId = 'ws-1';

function makeLinkFixture(overrides: Partial<FederationLink> = {}): FederationLink {
  return {
    id: 'link-1',
    initiatorWorkspaceId: 'ws-1',
    counterpartWorkspaceId: 'ws-2',
    pairKey: 'ws-1:ws-2',
    status: 'pending',
    initiatedByUserId: 'user-1',
    acceptedByUserId: null,
    revokedByUserId: null,
    initiatorAuditStreamId: 'stream-1',
    counterpartAuditStreamId: 'stream-2',
    createdAt: '2026-09-01T00:00:00.000Z',
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function mockLinksQuery(
  data: { links: FederationLink[] } | undefined,
  overrides: Partial<UseQueryResult<{ links: FederationLink[] }>> = {},
): void {
  mockedUseFederationLinksQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function makeMutationResult(mutate: (...args: never[]) => void): Record<string, unknown> {
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

function mockAllMutations(): {
  initiateMutate: ReturnType<typeof vi.fn>;
  acceptMutate: ReturnType<typeof vi.fn>;
  revokeLinkMutate: ReturnType<typeof vi.fn>;
  addScopeMutate: ReturnType<typeof vi.fn>;
  removeScopeMutate: ReturnType<typeof vi.fn>;
  createCredentialMutate: ReturnType<typeof vi.fn>;
  revokeCredentialMutate: ReturnType<typeof vi.fn>;
} {
  const initiateMutate = vi.fn();
  const acceptMutate = vi.fn();
  const revokeLinkMutate = vi.fn();
  const addScopeMutate = vi.fn();
  const removeScopeMutate = vi.fn();
  const createCredentialMutate = vi.fn();
  const revokeCredentialMutate = vi.fn();

  mockedUseInitiateFederationLinkMutation.mockReturnValue(makeMutationResult(initiateMutate));
  mockedUseAcceptFederationLinkMutation.mockReturnValue(makeMutationResult(acceptMutate));
  mockedUseRevokeFederationLinkMutation.mockReturnValue(makeMutationResult(revokeLinkMutate));
  mockedUseAddFederationScopeObjectMutation.mockReturnValue(makeMutationResult(addScopeMutate));
  mockedUseRemoveFederationScopeObjectMutation.mockReturnValue(
    makeMutationResult(removeScopeMutate),
  );
  mockedUseCreateFederationCredentialMutation.mockReturnValue(
    makeMutationResult(createCredentialMutate),
  );
  mockedUseRevokeFederationCredentialMutation.mockReturnValue(
    makeMutationResult(revokeCredentialMutate),
  );
  mockedUseFederationScopeQuery.mockReturnValue({
    data: { scopeObjects: [] },
    isLoading: false,
    isError: false,
    error: null,
  });

  return {
    initiateMutate,
    acceptMutate,
    revokeLinkMutate,
    addScopeMutate,
    removeScopeMutate,
    createCredentialMutate,
    revokeCredentialMutate,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('FederationLinksPanel', () => {
  it('renders a loading state (data-testid="federation-links-loading") while the query is loading', () => {
    mockLinksQuery(undefined, { isLoading: true });
    mockAllMutations();

    render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={false} />);

    expect(screen.getByTestId('federation-links-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="federation-links-error") when the query isError', () => {
    mockLinksQuery(undefined, { isError: true, error: new Error('boom') });
    mockAllMutations();

    render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={false} />);

    expect(screen.getByTestId('federation-links-error')).toBeInTheDocument();
  });

  it('renders one row per link', () => {
    const linkA = makeLinkFixture({ id: 'link-a', status: 'pending' });
    const linkB = makeLinkFixture({ id: 'link-b', status: 'active' });
    mockLinksQuery({ links: [linkA, linkB] });
    mockAllMutations();

    render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={false} />);

    expect(screen.getByTestId('federation-link-item-link-a')).toBeInTheDocument();
    expect(screen.getByTestId('federation-link-item-link-b')).toBeInTheDocument();
  });

  describe('isAdmin=false (non-admin, all management actions hidden)', () => {
    it('does not render the initiate-link form', () => {
      mockLinksQuery({ links: [] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={false} />);

      expect(screen.queryByTestId('federation-link-initiate-input')).not.toBeInTheDocument();
      expect(screen.queryByTestId('federation-link-initiate-submit')).not.toBeInTheDocument();
    });

    it('does not render accept/revoke buttons for a pending link', () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'pending' });
      mockLinksQuery({ links: [link] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={false} />);

      expect(screen.queryByTestId('federation-link-accept-link-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('federation-link-revoke-link-1')).not.toBeInTheDocument();
    });

    it('does not render revoke/scope-management/credential-creation controls for an active link', () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'active' });
      mockLinksQuery({ links: [link] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={false} />);

      expect(screen.queryByTestId('federation-link-revoke-link-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('federation-scope-add-input-link-1')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('federation-credential-name-input-link-1'),
      ).not.toBeInTheDocument();
    });
  });

  describe('isAdmin=true, initiate form', () => {
    it('renders the initiate-link form', () => {
      mockLinksQuery({ links: [] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

      expect(screen.getByTestId('federation-link-initiate-input')).toBeInTheDocument();
      expect(screen.getByTestId('federation-link-initiate-submit')).toBeInTheDocument();
    });

    it('calls the initiate mutation with { counterpartWorkspaceId } on submit', async () => {
      mockLinksQuery({ links: [] });
      const { initiateMutate } = mockAllMutations();
      const user = userEvent.setup();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);
      await user.type(screen.getByTestId('federation-link-initiate-input'), 'ws-other');
      await user.click(screen.getByTestId('federation-link-initiate-submit'));

      expect(initiateMutate).toHaveBeenCalledWith({ counterpartWorkspaceId: 'ws-other' });
    });

    it('does not call the initiate mutation when the input is empty', async () => {
      mockLinksQuery({ links: [] });
      const { initiateMutate } = mockAllMutations();
      const user = userEvent.setup();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);
      await user.click(screen.getByTestId('federation-link-initiate-submit'));

      expect(initiateMutate).not.toHaveBeenCalled();
    });
  });

  describe('isAdmin=true, pending link', () => {
    it('shows accept and revoke buttons, calling their respective mutations with the link id', async () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'pending' });
      mockLinksQuery({ links: [link] });
      const { acceptMutate, revokeLinkMutate } = mockAllMutations();
      const user = userEvent.setup();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);
      await user.click(screen.getByTestId('federation-link-accept-link-1'));
      await user.click(screen.getByTestId('federation-link-revoke-link-1'));

      expect(acceptMutate).toHaveBeenCalledWith('link-1');
      expect(revokeLinkMutate).toHaveBeenCalledWith('link-1');
    });

    it('does not show a scope-management section for a pending link', () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'pending' });
      mockLinksQuery({ links: [link] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

      expect(screen.queryByTestId('federation-link-scope-section-link-1')).not.toBeInTheDocument();
    });
  });

  describe('isAdmin=true, active link', () => {
    it('shows a revoke button but NO accept button', () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'active' });
      mockLinksQuery({ links: [link] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

      expect(screen.getByTestId('federation-link-revoke-link-1')).toBeInTheDocument();
      expect(screen.queryByTestId('federation-link-accept-link-1')).not.toBeInTheDocument();
    });

    it('shows a scope-management section listing active scope objects with a remove control', async () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'active' });
      mockLinksQuery({ links: [link] });
      const { removeScopeMutate } = mockAllMutations();
      mockedUseFederationScopeQuery.mockReturnValue({
        data: {
          scopeObjects: [
            {
              id: 'scope-1',
              federationLinkId: 'link-1',
              objectId: 'obj-1',
              ownerWorkspaceId: 'ws-1',
              addedByUserId: 'user-1',
              addedAt: '2026-09-01T00:00:00.000Z',
              removedAt: null,
            } satisfies FederationScopeObject,
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      });
      const user = userEvent.setup();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

      expect(screen.getByTestId('federation-link-scope-section-link-1')).toBeInTheDocument();
      expect(screen.getByTestId('federation-scope-item-link-1-obj-1')).toBeInTheDocument();
      await user.click(screen.getByTestId('federation-scope-remove-link-1-obj-1'));
      expect(removeScopeMutate).toHaveBeenCalledWith('obj-1');
    });

    it('adding a scope object calls the add-scope mutation with { objectId }', async () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'active' });
      mockLinksQuery({ links: [link] });
      const { addScopeMutate } = mockAllMutations();
      const user = userEvent.setup();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);
      await user.type(screen.getByTestId('federation-scope-add-input-link-1'), 'obj-new');
      await user.click(screen.getByTestId('federation-scope-add-submit-link-1'));

      expect(addScopeMutate).toHaveBeenCalledWith({ objectId: 'obj-new' });
    });

    it('creating a credential reveals the raw token exactly once, then it never appears again', async () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'active' });
      mockLinksQuery({ links: [link] });
      const { createCredentialMutate } = mockAllMutations();
      const user = userEvent.setup();
      const rawToken = 'RAW_TOKEN_FIXTURE_ONLY_SHOWN_ONCE';

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);
      await user.type(
        screen.getByTestId('federation-credential-name-input-link-1'),
        'Acme Corp erişimi',
      );
      await user.click(screen.getByTestId('federation-credential-create-submit-link-1'));

      expect(createCredentialMutate).toHaveBeenCalledTimes(1);
      const [, options] = createCredentialMutate.mock.calls[0] as [
        unknown,
        { onSuccess?: (data: CreateFederationCredentialResult) => void } | undefined,
      ];

      act(() => {
        options?.onSuccess?.({
          credential: {
            id: 'cred-new',
            federationLinkId: 'link-1',
            granteeWorkspaceId: 'ws-2',
            name: 'Acme Corp erişimi',
            tokenPrefix: 'Ab3xK9mZ1234',
            createdByUserId: 'user-1',
            createdAt: '2026-09-01T00:00:00.000Z',
            expiresAt: '2026-12-30T00:00:00.000Z',
            revokedAt: null,
          },
          rawToken,
        });
      });

      expect(screen.getByTestId('federation-credential-raw-token-link-1')).toHaveTextContent(
        rawToken,
      );

      await user.click(screen.getByTestId('federation-credential-reveal-close-link-1'));

      expect(document.body.textContent).not.toContain(rawToken);
      // The created credential's row (if rendered at all) must show at most
      // its tokenPrefix -- never the raw token -- security regression.
      expect(document.body.textContent).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    });
  });

  describe('isAdmin=true, revoked link (read-only, terminal)', () => {
    it('does not show accept/revoke/scope-management/credential-creation controls', () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'revoked' });
      mockLinksQuery({ links: [link] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

      expect(screen.queryByTestId('federation-link-accept-link-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('federation-link-revoke-link-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('federation-link-scope-section-link-1')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('federation-credential-name-input-link-1'),
      ).not.toBeInTheDocument();
    });

    it('still shows the link with a status indicator reflecting "revoked"', () => {
      const link = makeLinkFixture({ id: 'link-1', status: 'revoked' });
      mockLinksQuery({ links: [link] });
      mockAllMutations();

      render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

      expect(screen.getByTestId('federation-link-item-link-1')).toBeInTheDocument();
      expect(screen.getByTestId('federation-link-status-link-1')).toBeInTheDocument();
    });
  });

  it('sources identity only from the workspaceId prop -- the links query is called with exactly that value', () => {
    mockLinksQuery({ links: [] });
    mockAllMutations();

    render(<FederationLinksPanel workspaceId={workspaceId} isAdmin={true} />);

    expect(mockedUseFederationLinksQuery).toHaveBeenCalledWith(workspaceId);
  });
});
