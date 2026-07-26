import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ViewSwitcher } from './ViewSwitcher.js';
import { useViewParam } from '../hooks/useViewParam.js';

import type { ViewKind } from '../hooks/useViewParam.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/ViewSwitcher.tsx to satisfy these tests):
 *
 *   export function ViewSwitcher(): React.JSX.Element;
 *
 * Takes no props. Reads `{ view, setView }` from `useViewParam()`
 * (../hooks/useViewParam.ts, pinned separately by
 * apps/web/src/hooks/useViewParam.test.ts — mocked wholesale here) and
 * renders `@luminaos/ui`'s TabsRoot/TabsList/TabsTrigger, CONTROLLED:
 *
 *   <TabsRoot value={view} onValueChange={(next) => setView(next as ViewKind)}>
 *     <TabsList aria-label="...">
 *       <TabsTrigger value="list" data-testid="view-tab-list">...</TabsTrigger>
 *       <TabsTrigger value="board" data-testid="view-tab-board">...</TabsTrigger>
 *       <TabsTrigger value="table" data-testid="view-tab-table">...</TabsTrigger>
 *     </TabsList>
 *   </TabsRoot>
 *
 * Trigger copy is i18n-owned and NOT pinned by these tests — each trigger is
 * located via `data-testid="view-tab-<kind>"` instead (kind is one of
 * useViewParam's `ViewKind = 'list' | 'board' | 'table'`). No `TabsContent`
 * is required here — ViewSwitcher only owns the tab strip; the actual
 * List/Board/Table panels are rendered by ViewSwitcher's caller based on the
 * same `view` value, not by ViewSwitcher itself.
 *
 * ArrowRight/ArrowLeft keyboard navigation between tabs is Radix's own
 * "automatic activation" behavior (see
 * packages/ui/src/components/Tabs/Tabs.test.tsx) — exercised here only to
 * confirm ViewSwitcher wires `onValueChange` through to `setView` so it also
 * fires on keyboard-driven activation, not just clicks.
 */

vi.mock('../hooks/useViewParam.js', () => ({
  useViewParam: vi.fn(),
}));

const mockedUseViewParam = vi.mocked(useViewParam);

function mockView(view: ViewKind): ReturnType<typeof vi.fn> {
  const setView = vi.fn();
  mockedUseViewParam.mockReturnValue({ view, setView });
  return setView;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ViewSwitcher', () => {
  it('marks the tab matching the current view (from useViewParam) as selected', () => {
    mockView('board');

    render(<ViewSwitcher />);

    expect(screen.getByTestId('view-tab-board')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('view-tab-list')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('view-tab-table')).toHaveAttribute('aria-selected', 'false');
  });

  it("clicking a tab calls setView with that tab's view kind", async () => {
    const setView = mockView('list');
    const user = userEvent.setup();
    render(<ViewSwitcher />);

    await user.click(screen.getByTestId('view-tab-table'));

    expect(setView).toHaveBeenCalledWith('table');
  });

  it('ArrowRight from the focused active tab moves focus to the next tab and calls setView with its view kind', async () => {
    const setView = mockView('list');
    const user = userEvent.setup();
    render(<ViewSwitcher />);

    screen.getByTestId('view-tab-list').focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByTestId('view-tab-board')).toHaveFocus();
    expect(setView).toHaveBeenCalledWith('board');
  });
});
