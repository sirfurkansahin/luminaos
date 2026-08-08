import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './CommandPalette.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { searchWorkspace } from '../../lib/apiClient.js';

import type { SearchResult } from '../../lib/apiClient.js';
import type { ReactNode } from 'react';

/**
 * F1-T13 PR7 (ADR-0013) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/views/shared/CommandPalette.tsx to satisfy these tests):
 *
 *   export function CommandPalette({ workspaceId }: { workspaceId: string }): JSX.Element
 *
 * - Renders NOTHING visible by default (closed) — but IS mounted (always in
 *   the tree, listening for the global shortcut) so it can be added once near
 *   the top of App.tsx and just work.
 * - A global `Cmd+K` (metaKey) OR `Ctrl+K` (ctrlKey) keydown anywhere in the
 *   document OPENS the palette (a Dialog): shows a text input
 *   (data-testid="command-palette-input"), autofocused, and (once results
 *   exist) a results list.
 * - Typing in the input debounces 250ms (via useDebouncedValue) before
 *   triggering useSearchQuery — searchWorkspace is NOT called on every
 *   keystroke, only ~250ms after the user stops typing.
 * - Results are grouped by `type` into sections with Turkish headers, in this
 *   FIXED order: 'task' -> 'Görevler', 'doc' -> 'Dokümanlar',
 *   'note' -> 'Notlar', 'timeblock' -> 'Zaman Blokları'. A group section only
 *   renders if it has at least one result (no empty-section headers).
 * - Each result row: data-testid="command-palette-result", role="option",
 *   aria-selected reflecting whether it's the currently-active row. The FIRST
 *   result (flat index 0, across all rendered groups in the fixed order
 *   above) is active by default once results exist.
 * - ArrowDown/ArrowUp move the active selection across the FLATTENED list of
 *   all visible results (in the order the groups/rows are rendered) and CLAMP
 *   at the boundaries (ArrowUp on the first result / ArrowDown on the last
 *   result is a no-op — does NOT wrap). This is a judgment call: clamping was
 *   chosen over wrapping as the simpler, more common palette convention
 *   (VS Code's Cmd+P, for example, wraps — but nothing in the spec pins
 *   either way, so implementer must match THIS clamp behavior exactly).
 * - Enter on the currently-active result calls openObject(result.objectId)
 *   and CLOSES the palette (input clears, dialog closes).
 * - Escape closes the palette without navigating anywhere (openObject NOT
 *   called).
 * - Clicking a result row (not just keyboard) also calls
 *   openObject(result.objectId) and closes the palette.
 * - Closing and RE-OPENING the palette (Cmd/Ctrl+K again) resets the input to
 *   empty (no stale query/results carried over from the previous open).
 *
 * Judgment calls (so implementer matches exactly):
 *   1. Active-row marker: `role="option"` + `aria-selected="true"|"false"` on
 *      each `data-testid="command-palette-result"` row (mirrors the ARIA
 *      listbox/option pattern rather than inventing a bespoke class/testid).
 *   2. ArrowUp/ArrowDown at a boundary CLAMPS (stays put), does not wrap.
 *   3. Debounce is tested with REAL timers (not `vi.useFakeTimers()`) plus
 *      `waitFor`'s real-timer polling: mixing `vi.useFakeTimers()` with
 *      `userEvent`'s internal keystroke scheduling is fragile in this
 *      codebase's React 18 + user-event v14 setup (see
 *      useDebouncedValue.test.ts, which only ever drives fake timers through
 *      `renderHook` + `act`, never through `userEvent`). Typing via
 *      `userEvent.type` with the library's default (near-zero) inter-keystroke
 *      delay reliably finishes well under 250ms of real wall-clock time, so
 *      asserting "not called immediately after typing finishes" is safe
 *      without fake timers, and a real 250ms+ `waitFor` window (well within
 *      its default 1000ms timeout) reliably observes the debounced call.
 *   4. Global Cmd/Ctrl+K and Escape/Arrow/Enter interactions are driven via
 *      `userEvent.keyboard(...)`'s modifier-hold syntax
 *      (`{Meta>}k{/Meta}` / `{Control>}k{/Control}`), targeting
 *      `document.activeElement` (mirrors this codebase's own
 *      `TableView.test.tsx`/`StatusPrioritySelect.test.tsx` convention of
 *      `await user.keyboard('{ArrowDown}')` after focusing an element —
 *      here the "focused element" starts as `document.body` for the
 *      open-shortcut, since nothing is focused until the palette opens the
 *      autofocused input).
 */

vi.mock('../../lib/apiClient.js', () => ({
  searchWorkspace: vi.fn(),
}));

vi.mock('../../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

const mockedSearchWorkspace = vi.mocked(searchWorkspace);
const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);

const WORKSPACE_ID = 'ws-1';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { queryClient, Wrapper };
}

function renderPalette() {
  const { Wrapper } = createWrapper();
  return render(<CommandPalette workspaceId={WORKSPACE_ID} />, { wrapper: Wrapper });
}

function mockOpenObject() {
  const openObject = vi.fn();
  mockedUseObjectIdParam.mockReturnValue({
    objectId: undefined,
    openObject,
    closeObject: vi.fn(),
  });
  return openObject;
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    objectId: 'obj-1',
    title: 'Q3 Roadmap',
    type: 'task',
    score: 0.9,
    ...overrides,
  };
}

async function openViaMeta(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.keyboard('{Meta>}k{/Meta}');
}

beforeEach(() => {
  mockOpenObject();
  mockedSearchWorkspace.mockResolvedValue({ results: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CommandPalette', () => {
  it('renders nothing visible by default (closed)', () => {
    renderPalette();

    expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
  });

  it('Cmd+K (metaKey) opens the palette with an autofocused input', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);

    const input = screen.getByTestId('command-palette-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('Ctrl+K (ctrlKey) also opens the palette (cross-platform)', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();
  });

  it('Escape closes the palette without calling openObject', async () => {
    const openObject = mockOpenObject();
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });
    expect(openObject).not.toHaveBeenCalled();
  });

  it('debounces the query 250ms before calling searchWorkspace — not on every keystroke', async () => {
    mockedSearchWorkspace.mockResolvedValue({ results: [makeResult()] });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'roadmap');

    // user-event v14's default inter-keystroke delay is near-zero, so typing
    // 7 characters finishes well under the 250ms debounce window — no call
    // should have fired yet.
    expect(mockedSearchWorkspace).not.toHaveBeenCalled();

    await waitFor(
      () => {
        expect(mockedSearchWorkspace).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
    expect(mockedSearchWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, 'roadmap');
  });

  it('groups results by type with Turkish headers, only for types with >=1 result', async () => {
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 't-2', title: 'Task two', type: 'task' }),
        makeResult({ objectId: 'd-1', title: 'Doc one', type: 'doc' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(3);
    });

    expect(screen.getByText('Görevler')).toBeInTheDocument();
    expect(screen.getByText('Dokümanlar')).toBeInTheDocument();
    expect(screen.queryByText('Notlar')).not.toBeInTheDocument();
    expect(screen.queryByText('Zaman Blokları')).not.toBeInTheDocument();
  });

  it('ArrowDown/ArrowUp move the active selection across the flattened results, clamping at both ends', async () => {
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 't-2', title: 'Task two', type: 'task' }),
        makeResult({ objectId: 'd-1', title: 'Doc one', type: 'doc' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(3);
    });

    const activeIndex = (): number =>
      screen
        .getAllByTestId('command-palette-result')
        .findIndex((row) => row.getAttribute('aria-selected') === 'true');

    // Default active row is the first result.
    expect(activeIndex()).toBe(0);

    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(1);

    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(2);

    // Clamps at the last row — one more ArrowDown is a no-op.
    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(2);

    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(1);

    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(0);

    // Clamps at the first row — one more ArrowUp is a no-op.
    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(0);
  });

  it('Enter on the active result calls openObject with its objectId and closes the palette', async () => {
    const openObject = mockOpenObject();
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 't-2', title: 'Task two', type: 'task' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(2);
    });

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(openObject).toHaveBeenCalledWith('t-2');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });
  });

  it('clicking a result row calls openObject with its objectId and closes the palette', async () => {
    const openObject = mockOpenObject();
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 'd-1', title: 'Doc one', type: 'doc' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(2);
    });

    await user.click(screen.getByText('Doc one'));

    expect(openObject).toHaveBeenCalledWith('d-1');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });
  });

  it('re-opening after a close starts with an empty input (no stale query carried over)', async () => {
    mockedSearchWorkspace.mockResolvedValue({ results: [makeResult()] });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'roadmap');
    await waitFor(() => {
      expect(mockedSearchWorkspace).toHaveBeenCalledTimes(1);
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });

    await openViaMeta(user);

    expect(screen.getByTestId<HTMLInputElement>('command-palette-input').value).toBe('');
  });
});
