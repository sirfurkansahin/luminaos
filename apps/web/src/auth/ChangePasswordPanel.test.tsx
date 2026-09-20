import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangePasswordPanel } from './ChangePasswordPanel';
import { changePassword } from '../lib/apiClient';

vi.mock('../lib/apiClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/apiClient')>();
  return { ...original, changePassword: vi.fn() };
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChangePasswordPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(changePassword).mockResolvedValue();
});

describe('ChangePasswordPanel', () => {
  it('does not submit when the new password confirmation differs', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('Mevcut parola'), 'current-password');
    await user.type(screen.getByLabelText('Yeni parola'), 'new-secure-password');
    await user.type(screen.getByLabelText('Yeni parola tekrarı'), 'different-password');
    await user.click(screen.getByRole('button', { name: 'Parolayı değiştir' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('eşleşmiyor');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('submits the current and new password and confirms session rotation', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('Mevcut parola'), 'current-password');
    await user.type(screen.getByLabelText('Yeni parola'), 'new-secure-password');
    await user.type(screen.getByLabelText('Yeni parola tekrarı'), 'new-secure-password');
    await user.click(screen.getByRole('button', { name: 'Parolayı değiştir' }));

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalledWith('current-password', 'new-secure-password');
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Diğer açık oturumlar kapatıldı');
    expect(screen.getByLabelText('Mevcut parola')).toHaveValue('');
  });
});
