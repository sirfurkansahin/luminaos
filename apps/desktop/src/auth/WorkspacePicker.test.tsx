import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JSX } from 'react';

/**
 * RED-step tests for F2-T3b -- `apps/desktop/src/auth/WorkspacePicker.tsx`
 * does not exist yet (see
 * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL" item 7).
 *
 * Contract for `implementer`:
 * - Exports a named `WorkspacePicker` React component, prop
 *   `workspaces: {id: string; name: string}[]`.
 * - Renders one selectable option per entry in `workspaces`
 *   (`data-testid="workspace-option-${id}"`), showing that workspace's
 *   `name` as its text content.
 * - Clicking an option calls `setWorkspaceId(id)` (`../workspace-context.js`)
 *   with that workspace's `id`.
 *
 * Test strategy: `../workspace-context.js` is `vi.mock`'d so this file
 * tests `WorkspacePicker` in isolation from the real `localStorage` write
 * (already separately RED-tested in `../workspace-context.test.ts`).
 */

const mockSetWorkspaceId = vi.fn<(id: string) => void>();

vi.mock('../workspace-context', () => ({
  setWorkspaceId: (...args: unknown[]) =>
    (mockSetWorkspaceId as (...a: unknown[]) => unknown)(...args),
  getWorkspaceId: () => null,
}));

interface WorkspaceOption {
  id: string;
  name: string;
}

interface WorkspacePickerModuleLike {
  WorkspacePicker: (props: { workspaces: WorkspaceOption[] }) => JSX.Element;
}

/**
 * `./WorkspacePicker.tsx` genuinely does not exist ANYWHERE on disk yet --
 * this dynamic import is EXPECTED to fail Vite's module-resolution at
 * collection time (reporting this file as "0 test" / a failed suite, not a
 * per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal (same
 * `import-x/no-unresolved` caveat as `./SessionContext.test.tsx`).
 */
async function importWorkspacePickerModule(): Promise<WorkspacePickerModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/auth/WorkspacePicker.tsx does not exist yet.
  return (await import('./WorkspacePicker')) as unknown as WorkspacePickerModuleLike;
}

const WORKSPACES: WorkspaceOption[] = [
  { id: 'ws-1', name: 'First Workspace' },
  { id: 'ws-2', name: 'Second Workspace' },
  { id: 'ws-3', name: 'Third Workspace' },
];

describe('<WorkspacePicker /> (F2-T3b)', () => {
  beforeEach(() => {
    mockSetWorkspaceId.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders exactly one option per workspace, showing each workspace name', async () => {
    const { WorkspacePicker } = await importWorkspacePickerModule();
    render(<WorkspacePicker workspaces={WORKSPACES} />);

    for (const workspace of WORKSPACES) {
      const option = screen.getByTestId(`workspace-option-${workspace.id}`);
      expect(option).toBeInTheDocument();
      expect(option).toHaveTextContent(workspace.name);
    }
  });

  it('clicking an option calls setWorkspaceId with that workspace id, and no other', async () => {
    const { WorkspacePicker } = await importWorkspacePickerModule();
    render(<WorkspacePicker workspaces={WORKSPACES} />);

    fireEvent.click(screen.getByTestId('workspace-option-ws-2'));

    expect(mockSetWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockSetWorkspaceId).toHaveBeenCalledWith('ws-2');
  });
});
