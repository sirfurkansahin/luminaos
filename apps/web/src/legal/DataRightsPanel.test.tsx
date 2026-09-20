import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataRightsPanel } from './DataRightsPanel';
import {
  createDeletionRequest,
  getLatestDataRightsRequest,
  getWorkspaceExportUrl,
} from '../lib/apiClient';

vi.mock('../lib/apiClient', () => ({
  getWorkspaceExportUrl: vi.fn(),
  getLatestDataRightsRequest: vi.fn(),
  createDeletionRequest: vi.fn(),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DataRightsPanel workspaceId="workspace/id" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorkspaceExportUrl).mockReturnValue('/workspaces/workspace%2Fid/export?format=json');
  vi.mocked(getLatestDataRightsRequest).mockResolvedValue({ request: null });
});

describe('DataRightsPanel', () => {
  it('offers a same-workspace JSON export and an explicit-confirmation deletion request', async () => {
    renderPanel();

    expect(screen.getByRole('link', { name: 'JSON verilerimi indir' })).toHaveAttribute(
      'href',
      '/workspaces/workspace%2Fid/export?format=json',
    );
    expect(screen.getByRole('heading', { name: 'Hesap silme talebi' })).toBeVisible();
    expect(screen.getByText(/30 gün/i)).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Silme talebi oluştur' })).toBeDisabled();
  });

  it('creates the request only after confirmation and shows its tracking id', async () => {
    const user = userEvent.setup();
    vi.mocked(createDeletionRequest).mockResolvedValue({
      request: {
        id: 'request-123',
        type: 'deletion',
        status: 'pending',
        requestedAt: '2026-09-21T12:00:00.000Z',
        resolvedAt: null,
      },
    });
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Silme talebi oluştur' });
    await user.click(screen.getByRole('checkbox'));
    await user.click(button);

    await waitFor(() => {
      expect(createDeletionRequest).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText(/request-123/)).toBeVisible();
    expect(screen.getByText('Silme talebiniz incelemede')).toBeVisible();
  });
});
