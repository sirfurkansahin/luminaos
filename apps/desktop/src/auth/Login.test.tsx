import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JSX } from 'react';

/**
 * RED-step tests for F2-T3b -- `apps/desktop/src/auth/Login.tsx` does not
 * exist yet (see `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`,
 * "HEDEF ŞEKİL" item 6).
 *
 * Contract for `implementer`:
 * - Exports a named `Login` React component, no props.
 * - Renders an email input (`data-testid="login-email-input"`), a password
 *   input (`data-testid="login-password-input"`, `type="password"`), and a
 *   submit button/control (`data-testid="login-submit-button"`).
 * - On submit, calls `useSession().login(email, password)`
 *   (`./SessionContext.js`) with the CURRENT values of the two inputs.
 * - If `login()` rejects, an error message is rendered
 *   (`data-testid="login-error-message"`) -- no unhandled promise
 *   rejection, no thrown error escaping the click handler.
 *
 * Test strategy: `./SessionContext.js` is `vi.mock`'d so this file tests
 * `Login` in isolation from `SessionContext`'s own (separately RED-tested,
 * see `./SessionContext.test.tsx`) mount/getMe/setWorkspaceId logic --
 * `useSession()` here is a bare stub returning a controllable `login` mock.
 */

const mockLogin = vi.fn<(email: string, password: string) => Promise<void>>();

vi.mock('./SessionContext', () => ({
  useSession: () => ({
    user: null,
    workspaces: [],
    loading: false,
    login: (...args: unknown[]) => (mockLogin as (...a: unknown[]) => unknown)(...args),
    logout: vi.fn(),
  }),
}));

interface LoginModuleLike {
  Login: () => JSX.Element;
}

/**
 * `./Login.tsx` genuinely does not exist ANYWHERE on disk yet -- this
 * dynamic import is EXPECTED to fail Vite's module-resolution at collection
 * time (reporting this file as "0 test" / a failed suite, not a
 * per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal (same
 * `import-x/no-unresolved` caveat as `./SessionContext.test.tsx`).
 */
async function importLoginModule(): Promise<LoginModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/auth/Login.tsx does not exist yet.
  return (await import('./Login')) as unknown as LoginModuleLike;
}

describe('<Login /> (F2-T3b)', () => {
  beforeEach(() => {
    mockLogin.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an email input, a password input, and a submit button', async () => {
    const { Login } = await importLoginModule();
    render(<Login />);

    expect(screen.getByTestId('login-email-input')).toBeInTheDocument();
    expect(screen.getByTestId('login-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('login-password-input')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('login-submit-button')).toBeInTheDocument();
  });

  it('submitting the form calls useSession().login with the entered email and password', async () => {
    mockLogin.mockResolvedValueOnce(undefined);

    const { Login } = await importLoginModule();
    render(<Login />);

    fireEvent.change(screen.getByTestId('login-email-input'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByTestId('login-password-input'), {
      target: { value: 'super-secret' },
    });
    fireEvent.click(screen.getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('user@example.com', 'super-secret');
    });
  });

  it('shows an error message when login() rejects, instead of throwing unhandled', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Geçersiz e-posta veya şifre'));

    const { Login } = await importLoginModule();
    render(<Login />);

    fireEvent.change(screen.getByTestId('login-email-input'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByTestId('login-password-input'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByTestId('login-submit-button'));

    await waitFor(() => expect(screen.getByTestId('login-error-message')).toBeInTheDocument());
  });
});
