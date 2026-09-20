import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  ApiError,
  createWorkspace,
  getCurrentSession,
  getWorkspace,
  login,
  logout,
} from '../lib/apiClient';

import type { SessionUser, WorkspaceRole, WorkspaceSummary } from '../lib/apiClient';
import type { ReactNode, SyntheticEvent } from 'react';

const SESSION_QUERY_KEY = ['session'] as const;
const WORKSPACE_STORAGE_KEY = 'luminaos-workspace-id';

export interface ActiveSession {
  user: SessionUser;
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  onWorkspaceChange: (workspaceId: string) => void;
  onLogout: () => void;
  isLoggingOut: boolean;
}

interface SessionGateProps {
  children: (session: ActiveSession) => ReactNode;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode === 401;
}

function getInitialWorkspaceId(workspaces: WorkspaceSummary[]): string | undefined {
  const queryCandidate = new URLSearchParams(window.location.search).get('e2eWorkspaceId');
  const storedCandidate = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  return (
    workspaces.find((workspace) => workspace.id === queryCandidate)?.id ??
    workspaces.find((workspace) => workspace.id === storedCandidate)?.id ??
    workspaces[0]?.id
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const loginMutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess,
  });

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    loginMutation.mutate();
  };

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-heading">
        <p className="auth-eyebrow">LuminaOS kapalı beta</p>
        <h1 id="login-heading">Hesabınıza giriş yapın</h1>
        <p className="auth-description">
          Çalışma alanınıza devam etmek için beta hesabınızı kullanın.
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="login-email">E-posta</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <label htmlFor="login-password">Parola</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          {loginMutation.isError && (
            <p className="form-error" role="alert">
              {isUnauthorized(loginMutation.error)
                ? 'E-posta veya parola hatalı.'
                : 'Giriş şu anda tamamlanamadı. Lütfen tekrar deneyin.'}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={loginMutation.isPending}>
            {loginMutation.isPending ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>
      </section>
    </main>
  );
}

function FirstWorkspaceScreen({ onSuccess }: { onSuccess: (workspaceId: string) => void }) {
  const [name, setName] = useState('');
  const mutation = useMutation({
    mutationFn: () => createWorkspace(name.trim()),
    onSuccess: ({ workspace }) => {
      onSuccess(workspace.id);
    },
  });

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim().length > 0) {
      mutation.mutate();
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="workspace-heading">
        <p className="auth-eyebrow">İlk kurulum</p>
        <h1 id="workspace-heading">Çalışma alanınızı oluşturun</h1>
        <p className="auth-description">Ekibinizin işlerini tek yerde toplamaya başlayın.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="workspace-name">Çalışma alanı adı</label>
          <input
            id="workspace-name"
            required
            minLength={2}
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {mutation.isError && (
            <p className="form-error" role="alert">
              Çalışma alanı oluşturulamadı. Lütfen tekrar deneyin.
            </p>
          )}
          <button className="primary-button" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Oluşturuluyor…' : 'Çalışma alanını oluştur'}
          </button>
        </form>
      </section>
    </main>
  );
}

export function SessionGate({ children }: SessionGateProps) {
  const queryClient = useQueryClient();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [hasLoggedOut, setHasLoggedOut] = useState(false);
  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: getCurrentSession,
    retry: false,
  });

  const workspaces = sessionQuery.data?.workspaces ?? [];
  const workspaceId =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.id ??
    getInitialWorkspaceId(workspaces);

  useEffect(() => {
    if (!hasLoggedOut && workspaceId !== undefined) {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
    }
  }, [hasLoggedOut, workspaceId]);

  const workspaceQuery = useQuery({
    queryKey: ['workspace-session', workspaceId],
    queryFn: () => getWorkspace(workspaceId ?? ''),
    enabled: sessionQuery.isSuccess && workspaceId !== undefined,
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      setSelectedWorkspaceId(undefined);
      setHasLoggedOut(true);
      queryClient.clear();
    },
  });

  if (hasLoggedOut) {
    return (
      <LoginScreen
        onSuccess={async () => {
          setHasLoggedOut(false);
          await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }}
      />
    );
  }

  if (sessionQuery.isPending) {
    return (
      <main className="status-screen" aria-live="polite">
        Oturum yükleniyor…
      </main>
    );
  }

  if (sessionQuery.isError) {
    if (isUnauthorized(sessionQuery.error)) {
      return (
        <LoginScreen
          onSuccess={async () => {
            await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          }}
        />
      );
    }

    return (
      <main className="status-screen" role="alert">
        <p>Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.</p>
        <button
          className="primary-button"
          type="button"
          onClick={() => void sessionQuery.refetch()}
        >
          Tekrar dene
        </button>
      </main>
    );
  }

  if (workspaces.length === 0) {
    return (
      <FirstWorkspaceScreen
        onSuccess={(newWorkspaceId) => {
          setSelectedWorkspaceId(newWorkspaceId);
          void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }}
      />
    );
  }

  if (workspaceId === undefined || workspaceQuery.isPending) {
    return (
      <main className="status-screen" aria-live="polite">
        Çalışma alanı yükleniyor…
      </main>
    );
  }

  if (workspaceQuery.isError) {
    return (
      <main className="status-screen" role="alert">
        <p>Çalışma alanı açılamadı.</p>
        <button
          className="primary-button"
          type="button"
          onClick={() => void workspaceQuery.refetch()}
        >
          Tekrar dene
        </button>
      </main>
    );
  }

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaceQuery.data.workspace;

  return children({
    user: sessionQuery.data.user,
    workspaces,
    workspaceId,
    workspaceName: activeWorkspace.name,
    role: workspaceQuery.data.role,
    onWorkspaceChange: setSelectedWorkspaceId,
    onLogout: () => {
      logoutMutation.mutate();
    },
    isLoggingOut: logoutMutation.isPending,
  });
}
