import '@luminaos/ui/tokens.css';

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { Login } from './auth/Login';
import { SessionProvider, useSession } from './auth/SessionContext';
import { WorkspacePicker } from './auth/WorkspacePicker';
import { getWorkspaceId } from './workspace-context';

/**
 * Login/session composition root (F2-T3b) -- see
 * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL" item 4
 * (Open Question 2, Option B: no router library, plain conditional
 * rendering over `useSession()`'s state).
 *
 * Deliberately kept OUT of `App.tsx` itself: `App.tsx`'s own tests
 * (`App.test.tsx`, F2-T2b) render `<App />` directly with no
 * `SessionProvider` wrapping, so `App` must keep working standalone --
 * this session-gating shell wraps `App`, not the other way around.
 */
function Root(): React.JSX.Element {
  const { user, workspaces, loading, logout } = useSession();
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(() => getWorkspaceId());

  if (loading) {
    return <p>Yükleniyor…</p>;
  }

  if (user === null) {
    return <Login />;
  }

  if (workspaces.length > 1 && pickedWorkspaceId === null) {
    return <WorkspacePicker workspaces={workspaces} onSelect={setPickedWorkspaceId} />;
  }

  return (
    <>
      <App />
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
      >
        Çıkış yap
      </button>
    </>
  );
}

const container = document.getElementById('root');
if (!container) {
  // A bare `throw new Error` is deliberate here, not a `packages/shared/errors`
  // `AppError` subclass: this is a client-side bootstrap invariant (the mount
  // point missing from `index.html` is a build/deploy-config bug, never
  // user-triggered), mirroring `apps/web/src/main.tsx`'s identical reasoning.
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <Root />
    </SessionProvider>
  </StrictMode>,
);
