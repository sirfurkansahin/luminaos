import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedView } from '@luminaos/core-objects';

import { SavedViewsList } from './SavedViewsList.js';
import { useSavedViewsQuery } from '../hooks/useSavedViewsQuery.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/SavedViewsList.tsx to satisfy these tests. That's the
 * expected TDD red state.):
 *
 *   export interface SavedViewsListProps {
 *     workspaceId: string;
 *     objectType: string;
 *     onSelect: (savedView: SavedView) => void;
 *     canManage: (savedView: SavedView) => boolean;
 *       // presentational-only — the actual ownership/admin computation
 *       // lives with the caller (App.tsx / a future auth context), NOT in
 *       // this component. Real enforcement is the server's 403, per F1-T9
 *       // plan. `onRename`/`onDelete` callbacks (if any) are this
 *       // component's/implementer's own choice and are not pinned here.
 *   }
 *   export function SavedViewsList(props: SavedViewsListProps): React.JSX.Element;
 *
 * Internally calls `useSavedViewsQuery(workspaceId, objectType)`
 * (../hooks/useSavedViewsQuery.ts, mocked wholesale here — its own contract
 * is pinned separately by useSavedViewsQuery.test.ts).
 *
 * Renders one of four states, mirroring CalendarView/TimelineView's testid
 * convention:
 *   - isLoading: true                        -> data-testid="saved-views-list-loading"
 *   - isError: true                          -> data-testid="saved-views-list-error"
 *   - data.savedViews.length === 0           -> data-testid="saved-views-list-empty"
 *   - otherwise                              -> one item per saved view,
 *     `data-testid={`saved-view-item-${savedView.id}`}`, showing its resolved
 *     icon (via ../views/shared/IconPicker.ts's `resolveIcon`, mocked
 *     wholesale here to decouple this suite from IconPicker's own
 *     implementation) and its `name`. Clicking an item (but not its overflow
 *     manage button) calls `onSelect(savedView)` with the full object.
 *
 * A manage affordance (`data-testid={`saved-view-manage-button-${savedView.id}`}`)
 * is rendered for a given item if and only if `canManage(savedView)` returns
 * true — this suite only asserts presence/absence, never what clicking it
 * does (that's SaveViewButton/App.tsx wiring, out of this PR2 test scope).
 */

vi.mock('../hooks/useSavedViewsQuery.js', () => ({
  useSavedViewsQuery: vi.fn(),
}));

vi.mock('./shared/IconPicker.js', () => ({
  resolveIcon: vi.fn(
    (name: string | undefined) =>
      function MockedIcon() {
        return createElement('svg', { 'data-testid': `resolved-icon-${name ?? 'fallback'}` });
      },
  ),
}));

const mockedUseSavedViewsQuery = vi.mocked(useSavedViewsQuery);

const workspaceId = 'ws-1';
const objectType = 'task';

function makeSavedViewFixture(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'sv-1',
    workspaceId,
    objectType,
    name: 'Acil görevler',
    icon: 'Star',
    viewType: 'board',
    querySpec: { objectType, filters: [] },
    ownerId: null,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function mockQuery(
  data: { savedViews: SavedView[] } | undefined,
  overrides: Partial<UseQueryResult<{ savedViews: SavedView[] }>> = {},
): void {
  mockedUseSavedViewsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as UseQueryResult<{ savedViews: SavedView[] }>);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SavedViewsList', () => {
  it('renders a loading state (data-testid="saved-views-list-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={vi.fn()}
        canManage={() => false}
      />,
    );

    expect(screen.getByTestId('saved-views-list-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="saved-views-list-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={vi.fn()}
        canManage={() => false}
      />,
    );

    expect(screen.getByTestId('saved-views-list-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="saved-views-list-empty") when there are no saved views', () => {
    mockQuery({ savedViews: [] });

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={vi.fn()}
        canManage={() => false}
      />,
    );

    expect(screen.getByTestId('saved-views-list-empty')).toBeInTheDocument();
  });

  it('renders one item per saved view with its resolved icon and name', () => {
    const personal = makeSavedViewFixture({ id: 'sv-1', name: 'Benim görünümüm', icon: 'Star' });
    const shared = makeSavedViewFixture({
      id: 'sv-2',
      name: 'Paylaşılan görünüm',
      icon: 'Kanban',
      ownerId: null,
    });
    mockQuery({ savedViews: [personal, shared] });

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={vi.fn()}
        canManage={() => false}
      />,
    );

    const personalItem = screen.getByTestId('saved-view-item-sv-1');
    expect(personalItem).toHaveTextContent('Benim görünümüm');
    expect(screen.getByTestId('resolved-icon-Star')).toBeInTheDocument();

    const sharedItem = screen.getByTestId('saved-view-item-sv-2');
    expect(sharedItem).toHaveTextContent('Paylaşılan görünüm');
    expect(screen.getByTestId('resolved-icon-Kanban')).toBeInTheDocument();
  });

  it('calls onSelect with the full saved view object when an item is clicked', async () => {
    const savedView = makeSavedViewFixture({ id: 'sv-1', name: 'Acil görevler' });
    mockQuery({ savedViews: [savedView] });
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={onSelect}
        canManage={() => false}
      />,
    );

    await user.click(screen.getByTestId('saved-view-item-sv-1'));

    expect(onSelect).toHaveBeenCalledWith(savedView);
  });

  it('renders a manage affordance for an item only when canManage returns true for it', () => {
    const manageable = makeSavedViewFixture({ id: 'sv-1', ownerId: 'user-1' });
    const notManageable = makeSavedViewFixture({ id: 'sv-2', ownerId: 'user-2' });
    mockQuery({ savedViews: [manageable, notManageable] });

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={vi.fn()}
        canManage={(savedView) => savedView.id === 'sv-1'}
      />,
    );

    expect(screen.getByTestId('saved-view-manage-button-sv-1')).toBeInTheDocument();
    expect(screen.queryByTestId('saved-view-manage-button-sv-2')).not.toBeInTheDocument();
  });

  it('renders no manage affordances at all when canManage returns false for every item', () => {
    const savedView = makeSavedViewFixture({ id: 'sv-1' });
    mockQuery({ savedViews: [savedView] });

    render(
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={objectType}
        onSelect={vi.fn()}
        canManage={() => false}
      />,
    );

    expect(screen.queryByTestId('saved-view-manage-button-sv-1')).not.toBeInTheDocument();
  });
});
