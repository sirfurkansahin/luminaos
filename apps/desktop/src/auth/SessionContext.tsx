import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { getMe, login as loginRequest, logout as logoutRequest } from '../api/http-client.js';
import { setWorkspaceId } from '../workspace-context.js';

import type { MeResult, MeUser, MeWorkspace } from '../api/http-client.js';
import type { ReactNode } from 'react';

/**
 * Session-orchestration layer (F2-T3b) sitting on top of `http-client.ts`'s
 * `getMe`/`login`/`logout` and `workspace-context.ts`'s `setWorkspaceId` —
 * see `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL"
 * item 5, and Open Question 1 (Option B, v1 single-workspace assumption).
 */
export interface UseSessionResult {
  user: MeUser | null;
  workspaces: MeWorkspace[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<UseSessionResult | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<MeUser | null>(null);
  const [workspaces, setWorkspaces] = useState<MeWorkspace[]>([]);
  const [loading, setLoading] = useState(true);

  // Applies a fresh `getMe()` result to state, auto-selecting the
  // workspace when the caller has exactly one membership (v1 single-
  // workspace assumption) -- multi-workspace callers are left for
  // `WorkspacePicker` to resolve explicitly.
  const applyMeResult = useCallback((result: MeResult | null): void => {
    if (result === null) {
      setUser(null);
      setWorkspaces([]);
      return;
    }

    setUser(result.user);
    setWorkspaces(result.workspaces);

    if (result.workspaces.length === 1) {
      const [onlyWorkspace] = result.workspaces;
      if (onlyWorkspace) {
        setWorkspaceId(onlyWorkspace.id);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getMe().then((result) => {
      if (cancelled) {
        return;
      }
      applyMeResult(result);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [applyMeResult]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      await loginRequest(email, password);
      const result = await getMe();
      applyMeResult(result);
    },
    [applyMeResult],
  );

  const logout = useCallback(async (): Promise<void> => {
    await logoutRequest();
    setUser(null);
    setWorkspaces([]);
  }, []);

  return (
    <SessionContext.Provider value={{ user, workspaces, loading, login, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): UseSessionResult {
  const context = useContext(SessionContext);
  if (context === undefined) {
    // A bare `throw new Error` is deliberate here, not a
    // `packages/shared/errors` `AppError` subclass: this is the standard
    // React context-usage-guard pattern (a programmer-error assertion
    // caught at development time, never surfaced as an HTTP response) --
    // mirrors `packages/ui/src/theme/useTheme.ts`'s identical reasoning.
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
