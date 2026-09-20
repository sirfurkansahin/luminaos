import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from './SessionGate';
import {
  ApiError,
  createWorkspace,
  getCurrentSession,
  getWorkspace,
  login,
  logout,
} from '../lib/apiClient';

vi.mock('../lib/apiClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/apiClient')>();
  return {
    ...original,
    createWorkspace: vi.fn(),
    getCurrentSession: vi.fn(),
    getWorkspace: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  };
});

function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionGate>
        {(session) => (
          <div>
            <span data-testid="active-workspace">{session.workspaceId}</span>
            <span data-testid="active-user">{session.user.id}</span>
            <span data-testid="active-role">{session.role}</span>
            <select
              aria-label="Çalışma alanı"
              value={session.workspaceId}
              onChange={(event) => {
                session.onWorkspaceChange(event.target.value);
              }}
            >
              {session.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={session.onLogout}>
              Çıkış yap
            </button>
          </div>
        )}
      </SessionGate>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.mocked(login).mockResolvedValue({ user: { id: 'user-1', email: 'beta@example.com' } });
  vi.mocked(logout).mockResolvedValue();
  vi.mocked(createWorkspace).mockResolvedValue({
    workspace: { id: 'workspace-new', name: 'Yeni Alan' },
  });
  vi.mocked(getWorkspace).mockImplementation((workspaceId) =>
    Promise.resolve({
      workspace: { id: workspaceId, name: workspaceId },
      role: 'owner',
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SessionGate', () => {
  it('shows login to an unauthenticated visitor and submits credentials', async () => {
    vi.mocked(getCurrentSession)
      .mockRejectedValueOnce(new ApiError('Unauthorized', 'UNAUTHORIZED', 401))
      .mockResolvedValue({
        user: { id: 'user-1', email: 'beta@example.com' },
        workspaces: [{ id: 'workspace-1', name: 'Beta' }],
      });
    const user = userEvent.setup();
    renderGate();

    await user.type(await screen.findByLabelText('E-posta'), 'beta@example.com');
    await user.type(screen.getByLabelText('Parola'), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('beta@example.com', 'secret-password');
    });
    expect(await screen.findByTestId('active-workspace')).toHaveTextContent('workspace-1');
  });

  it('renders the only membership with the real user and server-derived role', async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({
      user: { id: 'user-1', email: 'beta@example.com' },
      workspaces: [{ id: 'workspace-1', name: 'Beta' }],
    });
    renderGate();

    expect(await screen.findByTestId('active-workspace')).toHaveTextContent('workspace-1');
    expect(screen.getByTestId('active-user')).toHaveTextContent('user-1');
    expect(screen.getByTestId('active-role')).toHaveTextContent('owner');
    expect(getWorkspace).toHaveBeenCalledWith('workspace-1');
  });

  it('ignores an untrusted persisted workspace and persists a valid selection', async () => {
    window.localStorage.setItem('luminaos-workspace-id', 'not-a-membership');
    window.history.replaceState({}, '', '/?e2eWorkspaceId=also-not-a-membership');
    vi.mocked(getCurrentSession).mockResolvedValue({
      user: { id: 'user-1', email: 'beta@example.com' },
      workspaces: [
        { id: 'workspace-1', name: 'Bir' },
        { id: 'workspace-2', name: 'İki' },
      ],
    });
    const user = userEvent.setup();
    renderGate();

    const picker = await screen.findByRole('combobox', { name: 'Çalışma alanı' });
    expect(picker).toHaveValue('workspace-1');
    await user.selectOptions(picker, 'workspace-2');

    await waitFor(() => {
      expect(window.localStorage.getItem('luminaos-workspace-id')).toBe('workspace-2');
    });
  });

  it('lets a member with no workspace create the first one', async () => {
    vi.mocked(getCurrentSession)
      .mockResolvedValueOnce({
        user: { id: 'user-1', email: 'beta@example.com' },
        workspaces: [],
      })
      .mockResolvedValue({
        user: { id: 'user-1', email: 'beta@example.com' },
        workspaces: [{ id: 'workspace-new', name: 'Yeni Alan' }],
      });
    const user = userEvent.setup();
    renderGate();

    await user.type(await screen.findByLabelText('Çalışma alanı adı'), 'Yeni Alan');
    await user.click(screen.getByRole('button', { name: 'Çalışma alanını oluştur' }));

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith('Yeni Alan');
    });
    expect(await screen.findByTestId('active-workspace')).toHaveTextContent('workspace-new');
  });

  it('revokes the session and clears the remembered workspace on logout', async () => {
    window.localStorage.setItem('luminaos-workspace-id', 'workspace-1');
    vi.mocked(getCurrentSession).mockResolvedValue({
      user: { id: 'user-1', email: 'beta@example.com' },
      workspaces: [{ id: 'workspace-1', name: 'Beta' }],
    });
    const user = userEvent.setup();
    renderGate();

    await user.click(await screen.findByRole('button', { name: 'Çıkış yap' }));

    await waitFor(() => {
      expect(logout).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem('luminaos-workspace-id')).toBeNull();
    });
  });
});
