import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocEditorPanel } from './DocEditorPanel.js';

/**
 * F1-T11 PR7 (RED step) — dialog wrapper that hosts the collaborative
 * `DocEditor` for a `doc`-type object. This file pins the contract of a
 * component that does NOT exist yet (apps/web/src/views/doc/DocEditorPanel.tsx),
 * so every case here fails purely because `./DocEditorPanel.js` cannot be
 * resolved until the implementer creates it. That is the intended TDD red state.
 *
 * Contract under test (implementer must build to satisfy):
 *
 *   export interface DocEditorPanelProps {
 *     docId: string;
 *     title: string;
 *     onClose: () => void;
 *   }
 *   export function DocEditorPanel(props: DocEditorPanelProps): React.JSX.Element;
 *
 * Mirrors TaskDetailPanel's dialog structure (packages/ui's real, non-mocked
 * `DialogRoot`/`DialogContent`/`DialogTitle`/`DialogClose`):
 *   - Renders `<DialogRoot open={true}>` with `onOpenChange={(open) => { if
 *     (!open) onClose(); }}` — so Escape, an outside click, or the close control
 *     all funnel through the single `onClose` callback.
 *   - `DialogContent` contains a `DialogTitle` showing `title`, the collaborative
 *     `<DocEditor docId={docId} />` (./DocEditor.js, mocked wholesale below so
 *     this file exercises only the panel wrapper, not BlockNote), and a
 *     `DialogClose data-testid="doc-editor-panel-close"`.
 */

interface CapturedDocEditorProps {
  docId: string;
}

vi.mock('./DocEditor.js', () => ({
  DocEditor: vi.fn((props: CapturedDocEditorProps) => (
    <div data-testid="doc-editor-mock" data-docid={props.docId} />
  )),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('DocEditorPanel', () => {
  it('renders the title and the DocEditor wired with the given docId', async () => {
    render(<DocEditorPanel docId="doc-1" title="Product spec" onClose={vi.fn()} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Product spec')).toBeInTheDocument();

    const editor = screen.getByTestId('doc-editor-mock');
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveAttribute('data-docid', 'doc-1');
  });

  it('renders a close control (data-testid="doc-editor-panel-close")', async () => {
    render(<DocEditorPanel docId="doc-1" title="Product spec" onClose={vi.fn()} />);

    expect(await screen.findByTestId('doc-editor-panel-close')).toBeInTheDocument();
  });

  it('calls onClose exactly once when the close control is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<DocEditorPanel docId="doc-1" title="Product spec" onClose={onClose} />);
    await screen.findByRole('dialog');

    await user.click(screen.getByTestId('doc-editor-panel-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
