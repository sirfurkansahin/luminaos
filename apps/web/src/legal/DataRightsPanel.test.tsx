import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DataRightsPanel } from './DataRightsPanel';

describe('DataRightsPanel', () => {
  it('offers a same-workspace JSON export and explains assisted deletion', () => {
    render(<DataRightsPanel workspaceId="workspace/id" />);

    expect(screen.getByRole('link', { name: 'JSON verilerimi indir' })).toHaveAttribute(
      'href',
      '/workspaces/workspace%2Fid/export?format=json',
    );
    expect(screen.getByRole('heading', { name: 'Hesap silme talebi' })).toBeVisible();
    expect(screen.getByText(/30 gün/i)).toBeVisible();
  });
});
