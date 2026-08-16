import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JSX } from 'react';

/**
 * RED-step tests for F2-T3b -- `apps/desktop/src/auth/SessionContext.tsx`
 * does not exist yet (see
 * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL" item 5).
 *
 * Contract for `implementer`:
 *
 * - Exports `SessionProvider` (React Context provider component, `children`
 *   prop) and `useSession()` (hook, must be called inside a
 *   `SessionProvider`).
 * - On mount, `SessionProvider` calls `getMe()` (`../api/http-client.js`).
 *   `loading` starts `true`, becomes `false` once `getMe()` resolves
 *   (whichever branch below).
 * - If `getMe()` resolves `null` (no session), `user` is `null`,
 *   `workspaces` is `[]`.
 * - If `getMe()` resolves `{user, workspaces}`:
 *   - `user`/`workspaces` state is populated from it.
 *   - If `workspaces.length === 1`, `setWorkspaceId(workspaces[0].id)`
 *     (`../workspace-context.js`) is called AUTOMATICALLY -- no user
 *     interaction needed (single-workspace v1 assumption, Open Question 1
 *     Option B).
 *   - If `workspaces.length > 1`, `setWorkspaceId` is NOT called
 *     automatically -- the user must pick (via `WorkspacePicker`).
 * - `useSession()` returns `{user, workspaces, loading, login, logout}`:
 *   - `login(email, password)`: calls `http-client.login(email, password)`,
 *     then RE-CALLS `getMe()` and updates `user`/`workspaces` state from the
 *     fresh result.
 *   - `logout()`: calls `http-client.logout()`, then resets `user` to
 *     `null` and `workspaces` to `[]`.
 *
 * Test strategy: both `../api/http-client.js` and `../workspace-context.js`
 * are `vi.mock`'d (unlike sibling F2-T3 tests, which stub `fetch` directly
 * across the real seam) -- `SessionContext` is a STATE-ORCHESTRATION layer
 * on top of those two already-tested modules, so its own tests assert on
 * the orchestration logic (when is `getMe`/`setWorkspaceId` called, and
 * with what) rather than re-deriving HTTP/localStorage behavior that
 * `http-client.test.ts`/`workspace-context.test.ts` already cover.
 */

interface MeUser {
  id: string;
  email: string;
}

interface MeWorkspace {
  id: string;
  name: string;
}

interface MeResult {
  user: MeUser;
  workspaces: MeWorkspace[];
}

const mockGetMe = vi.fn<() => Promise<MeResult | null>>();
const mockLogin = vi.fn<(email: string, password: string) => Promise<MeUser>>();
const mockLogout = vi.fn<() => Promise<void>>();
const mockSetWorkspaceId = vi.fn<(id: string) => void>();

vi.mock('../api/http-client', () => ({
  getMe: (...args: unknown[]) => (mockGetMe as (...a: unknown[]) => unknown)(...args),
  login: (...args: unknown[]) => (mockLogin as (...a: unknown[]) => unknown)(...args),
  logout: (...args: unknown[]) => (mockLogout as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('../workspace-context', () => ({
  setWorkspaceId: (...args: unknown[]) =>
    (mockSetWorkspaceId as (...a: unknown[]) => unknown)(...args),
  getWorkspaceId: () => null,
}));

interface UseSessionResult {
  user: MeUser | null;
  workspaces: MeWorkspace[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

interface SessionContextModuleLike {
  SessionProvider: (props: { children: JSX.Element }) => JSX.Element;
  useSession: () => UseSessionResult;
}

/**
 * `./SessionContext.tsx` genuinely does not exist ANYWHERE on disk yet --
 * this dynamic import is EXPECTED to fail Vite's module-resolution at
 * collection time (reporting this file as "0 test" / a failed suite, not a
 * per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal.
 *
 * LINT NOTE (mirrors `packages/shared/src/ids/deterministic-uuid.test.ts`'s
 * own note): until `SessionContext.tsx` exists, this import also produces
 * the one genuinely-expected `import-x/no-unresolved` ESLint error this
 * file is supposed to fail with -- not suppressed, since it resolves itself
 * automatically (no follow-up cleanup commit needed) the moment
 * `implementer` creates the file.
 */
async function importSessionContextModule(): Promise<SessionContextModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/auth/SessionContext.tsx does not exist yet.
  return (await import('./SessionContext')) as unknown as SessionContextModuleLike;
}

/**
 * A minimal consumer that surfaces `useSession()`'s state via testids and
 * exposes `login`/`logout` behind buttons, so tests can drive/observe the
 * hook without needing their own React component per scenario.
 */
function makeProbe(useSession: SessionContextModuleLike['useSession']) {
  return function Probe(): JSX.Element {
    const { user, workspaces, loading, login, logout } = useSession();
    return (
      <div>
        <div data-testid="loading">{String(loading)}</div>
        <div data-testid="user">{user ? user.email : 'null'}</div>
        <div data-testid="workspaces-count">{workspaces.length}</div>
        <button
          type="button"
          onClick={() => {
            void login('probe@example.com', 'probe-password');
          }}
        >
          login
        </button>
        <button
          type="button"
          onClick={() => {
            void logout();
          }}
        >
          logout
        </button>
      </div>
    );
  };
}

describe('SessionProvider / useSession (F2-T3b)', () => {
  beforeEach(() => {
    mockGetMe.mockReset();
    mockLogin.mockReset();
    mockLogout.mockReset();
    mockSetWorkspaceId.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mount calls getMe() exactly once; loading starts true and becomes false once it resolves', async () => {
    mockGetMe.mockResolvedValueOnce({
      user: { id: 'u-1', email: 'user@example.com' },
      workspaces: [],
    });

    const { SessionProvider, useSession } = await importSessionContextModule();
    const Probe = makeProbe(useSession);

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(mockGetMe).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
  });

  it('when getMe() resolves null, user is null (no session)', async () => {
    mockGetMe.mockResolvedValueOnce(null);

    const { SessionProvider, useSession } = await importSessionContextModule();
    const Probe = makeProbe(useSession);

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('user').textContent).toBe('null');
    expect(screen.getByTestId('workspaces-count').textContent).toBe('0');
  });

  it('when getMe() resolves exactly ONE workspace, setWorkspaceId is called automatically with its id', async () => {
    mockGetMe.mockResolvedValueOnce({
      user: { id: 'u-1', email: 'solo@example.com' },
      workspaces: [{ id: 'ws-solo', name: 'Solo Workspace' }],
    });

    const { SessionProvider, useSession } = await importSessionContextModule();
    const Probe = makeProbe(useSession);

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(mockSetWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockSetWorkspaceId).toHaveBeenCalledWith('ws-solo');
  });

  it('when getMe() resolves MULTIPLE workspaces, setWorkspaceId is NOT called automatically', async () => {
    mockGetMe.mockResolvedValueOnce({
      user: { id: 'u-1', email: 'multi@example.com' },
      workspaces: [
        { id: 'ws-1', name: 'First' },
        { id: 'ws-2', name: 'Second' },
      ],
    });

    const { SessionProvider, useSession } = await importSessionContextModule();
    const Probe = makeProbe(useSession);

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('workspaces-count').textContent).toBe('2');
    expect(mockSetWorkspaceId).not.toHaveBeenCalled();
  });

  it('login() calls http-client.login() then re-fetches getMe() and updates user state', async () => {
    mockGetMe.mockResolvedValueOnce(null);

    const { SessionProvider, useSession } = await importSessionContextModule();
    const Probe = makeProbe(useSession);

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('user').textContent).toBe('null');

    mockLogin.mockResolvedValueOnce({ id: 'u-1', email: 'probe@example.com' });
    mockGetMe.mockResolvedValueOnce({
      user: { id: 'u-1', email: 'probe@example.com' },
      workspaces: [],
    });

    fireEvent.click(screen.getByText('login'));

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('probe@example.com');
    });
    expect(mockLogin).toHaveBeenCalledWith('probe@example.com', 'probe-password');
    expect(mockGetMe).toHaveBeenCalledTimes(2);
  });

  it('logout() calls http-client.logout() and resets user/workspaces to empty', async () => {
    mockGetMe.mockResolvedValueOnce({
      user: { id: 'u-1', email: 'logged-in@example.com' },
      workspaces: [{ id: 'ws-1', name: 'Only Workspace' }],
    });

    const { SessionProvider, useSession } = await importSessionContextModule();
    const Probe = makeProbe(useSession);

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('logged-in@example.com');
    });

    mockLogout.mockResolvedValueOnce(undefined);

    fireEvent.click(screen.getByText('logout'));

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('null');
    });
    expect(screen.getByTestId('workspaces-count').textContent).toBe('0');
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
