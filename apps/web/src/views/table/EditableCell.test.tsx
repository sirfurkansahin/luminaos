import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EditableCell } from './EditableCell.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/table/EditableCell.tsx to satisfy these tests. That's
 * the expected TDD red state.):
 *
 *   export interface EditableCellProps {
 *     value: unknown;
 *     onCommit: (newValue: unknown) => void;
 *   }
 *   export function EditableCell(props: EditableCellProps): React.JSX.Element;
 *
 * Read-only mode (default): renders `value` (coerced to a string) as text,
 * discoverable via data-testid="editable-cell-display".
 *
 * Entering edit mode (via click OR Enter on the display) swaps to a
 * `@luminaos/ui` `Input` (a native <input> — `data-testid` passes through
 * via its `...rest` spread), discoverable via
 * data-testid="editable-cell-input", pre-filled with the current value.
 *
 * From edit mode:
 *   - Enter or blur COMMITS: calls `onCommit(newValue)` with the input's
 *     current (string) value and returns to read-only display mode.
 *   - Escape CANCELS: `onCommit` is NOT called, edit mode closes, and the
 *     display reverts to the ORIGINAL `value` prop (discarding the
 *     in-progress edit).
 */

describe('EditableCell', () => {
  it('renders the initial value as read-only text (data-testid="editable-cell-display")', () => {
    render(<EditableCell value="Hello" onCommit={vi.fn()} />);

    const display = screen.getByTestId('editable-cell-display');
    expect(display).toBeInTheDocument();
    expect(display).toHaveTextContent('Hello');
    expect(screen.queryByTestId('editable-cell-input')).not.toBeInTheDocument();
  });

  it('switches to edit mode (an Input pre-filled with the current value) when the display is clicked', async () => {
    const user = userEvent.setup();
    render(<EditableCell value="Hello" onCommit={vi.fn()} />);

    await user.click(screen.getByTestId('editable-cell-display'));

    const input = screen.getByTestId('editable-cell-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('Hello');
    expect(screen.queryByTestId('editable-cell-display')).not.toBeInTheDocument();
  });

  it('also switches to edit mode when Enter is pressed while the display is focused', async () => {
    const user = userEvent.setup();
    render(<EditableCell value="Hello" onCommit={vi.fn()} />);

    const display = screen.getByTestId('editable-cell-display');
    display.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('editable-cell-input')).toHaveValue('Hello');
  });

  it('commits the new value on Enter: calls onCommit with the typed value and exits edit mode', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableCell value="Hello" onCommit={onCommit} />);

    await user.click(screen.getByTestId('editable-cell-display'));
    const input = screen.getByTestId('editable-cell-input');
    await user.clear(input);
    await user.type(input, 'World{Enter}');

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith('World');
    });
    expect(screen.queryByTestId('editable-cell-input')).not.toBeInTheDocument();
  });

  it('also commits on blur (clicking away without pressing Enter)', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <div>
        <EditableCell value="Hello" onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </div>,
    );

    await user.click(screen.getByTestId('editable-cell-display'));
    const input = screen.getByTestId('editable-cell-input');
    await user.clear(input);
    await user.type(input, 'World');
    await user.click(screen.getByText('elsewhere'));

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith('World');
    });
  });

  it('cancels on Escape: onCommit is NOT called and the original value is restored', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableCell value="Hello" onCommit={onCommit} />);

    await user.click(screen.getByTestId('editable-cell-display'));
    const input = screen.getByTestId('editable-cell-input');
    await user.clear(input);
    await user.type(input, 'World{Escape}');

    expect(onCommit).not.toHaveBeenCalled();
    const display = screen.getByTestId('editable-cell-display');
    expect(display).toHaveTextContent('Hello');
    expect(screen.queryByTestId('editable-cell-input')).not.toBeInTheDocument();
  });
});
