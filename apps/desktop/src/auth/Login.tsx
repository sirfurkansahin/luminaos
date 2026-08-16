import { useState } from 'react';

import { useSession } from './SessionContext.js';

/**
 * Email/password login form (F2-T3b) -- see
 * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL" item 6.
 * Delegates the actual `POST /auth/login` call to `useSession().login`
 * (`./SessionContext.tsx`), which also re-fetches `GET /me` and applies the
 * single-workspace auto-selection.
 */
export function Login(): React.JSX.Element {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    try {
      await login(email, password);
    } catch {
      // The error's own message is deliberately NOT surfaced verbatim --
      // CLAUDE.md forbids logging/echoing user credentials, and the
      // server's own error message for a failed login is not guaranteed to
      // be free of user-supplied input either. A fixed, generic message is
      // shown instead.
      setErrorMessage('Geçersiz e-posta veya şifre');
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h1>Giriş yap</h1>
      <label>
        E-posta
        <input
          type="email"
          data-testid="login-email-input"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </label>
      <label>
        Şifre
        <input
          type="password"
          data-testid="login-password-input"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>
      <button type="submit" data-testid="login-submit-button">
        Giriş yap
      </button>
      {errorMessage !== null && <p data-testid="login-error-message">{errorMessage}</p>}
    </form>
  );
}
