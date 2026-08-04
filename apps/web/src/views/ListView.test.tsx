import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { ListView } from './ListView.js';
import { useObjectIdParam } from '../hooks/useObjectIdParam.js';
import { useObjectsQuery } from '../hooks/useObjectsQuery.js';

import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/ListView.tsx to satisfy these tests, and add
 * `@tanstack/react-virtual` + `@luminaos/shared` as runtime dependencies of
 * apps/web/package.json — neither is there yet, so these imports will fail
 * to resolve until then. That's the expected TDD red state.):
 *
 *   export interface ListViewProps {
 *     workspaceId: string;
 *     querySpec: QuerySpec;
 *   }
 *   export function ListView(props: ListViewProps): React.JSX.Element;
 *
 * Internally calls `useObjectsQuery(workspaceId, querySpec)`
 * (../hooks/useObjectsQuery.ts, pinned separately by
 * apps/web/src/hooks/useObjectsQuery.test.ts — mocked wholesale here) and
 * renders one of four states from its `{ data, isLoading, isError }` result:
 *
 *   - isLoading: true                       -> loading/skeleton state,
 *                                              root discoverable via
 *                                              data-testid="list-view-loading"
 *   - isError: true                         -> error state, root
 *                                              discoverable via
 *                                              data-testid="list-view-error"
 *   - data.objects.length === 0             -> empty state ("henüz nesne
 *                                              yok"), root discoverable via
 *                                              data-testid="list-view-empty"
 *   - data.objects.length > 0               -> a `@tanstack/react-virtual`
 *                                              virtualized row list; each
 *                                              rendered row carries
 *                                              data-testid="object-row" and
 *                                              shows the object's title (plus
 *                                              a handful of featured custom
 *                                              fields — exact field-selection
 *                                              logic is implementer's design
 *                                              choice, not pinned here).
 *
 * The virtualization case below asserts that with 500 objects, far fewer
 * than 500 `object-row` DOM nodes are actually rendered — the whole point of
 * virtualizing is to keep the DOM node count roughly proportional to the
 * viewport, not the dataset. Exact numbers are jsdom-environment-dependent
 * (no real layout engine), so a generous-but-still-meaningful upper bound
 * (<100) is used rather than pinning an exact row count.
 */

function makeObjects(count: number): ObjectWithFieldValues[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `obj-${String(index)}`,
        title: `Object ${String(index)}`,
        fieldValues: { status: index % 2 === 0 ? 'todo' : 'done' },
      }) as unknown as ObjectWithFieldValues,
  );
}

vi.mock('../hooks/useObjectsQuery.js', () => ({
  useObjectsQuery: vi.fn(),
}));

// ListView now also reads `openObject` from useObjectIdParam.ts (mocked
// wholesale, mirroring useObjectsQuery.js above) so its title span/row can
// open the detail panel on click/Enter — see the new "opens the detail
// panel" describe block below. This is an ADDED dependency, not previously
// present; every existing test above must still keep passing unchanged, so
// a default (objectId: undefined) mock return is wired in beforeEach.
vi.mock('../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

const mockedUseObjectsQuery = vi.mocked(useObjectsQuery);
const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);

const workspaceId = 'ws-1';
const querySpec: QuerySpec = { objectType: 'task', filters: [] };

beforeEach(() => {
  mockedUseObjectIdParam.mockReturnValue({
    objectId: undefined,
    openObject: vi.fn(),
    closeObject: vi.fn(),
  });

  // jsdom has no real layout engine (every element measures 0x0 by
  // default) and no ResizeObserver — @tanstack/react-virtual depends on
  // both to measure its scroll container and compute which rows fall in
  // the visible window. Without these stubs the virtualizer would see a
  // permanently 0-sized container, making the "renders far fewer DOM nodes
  // than the full object count" assertion below true for the wrong reason.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 800,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  });

  // @tanstack/react-virtual measures its scroll container via
  // ResizeObserver, reacting to the entry it receives rather than reading
  // clientHeight/getBoundingClientRect proactively on its own — a
  // ResizeObserver mock that never invokes its callback would leave the
  // virtualizer thinking the container is permanently 0-sized (0 rendered
  // rows), which would make the "renders far fewer rows than 500"
  // assertion below pass for the wrong reason. This mock fires its
  // callback synchronously on `observe()`, echoing the fixed size stubbed
  // above via `getBoundingClientRect()`.
  class ResizeObserverMock {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe = vi.fn((target: Element) => {
      const rect = target.getBoundingClientRect();
      const size = { inlineSize: rect.width, blockSize: rect.height };
      const entry = {
        target,
        contentRect: rect,
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size],
      } as unknown as ResizeObserverEntry;
      this.callback([entry], this);
    });

    unobserve = vi.fn();
    disconnect = vi.fn();
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ListView', () => {
  it('renders a loading state (data-testid="list-view-loading") while the query is loading', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<ListView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('list-view-loading')).toBeInTheDocument();
    expect(screen.queryAllByTestId('object-row')).toHaveLength(0);
  });

  it('renders an empty state (data-testid="list-view-empty") when the query resolves with zero objects', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: { objects: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<ListView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('list-view-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('object-row')).toHaveLength(0);
  });

  it('renders far fewer DOM rows than the full object count for 500 objects (virtualization)', () => {
    const objects = makeObjects(500);
    mockedUseObjectsQuery.mockReturnValue({
      data: { objects },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<ListView workspaceId={workspaceId} querySpec={querySpec} />);

    const rows = screen.getAllByTestId('object-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    // objects[0]'s title is deterministic ('Object 0', per makeObjects above)
    // and index 0 is at the initial (unscrolled) top of the list, so it must
    // be among the first rows the virtualizer renders. `.join('')` coerces
    // each row's `textContent` (string | null) to a plain string.
    const renderedText = rows.map((row) => row.textContent).join('');
    expect(renderedText).toContain('Object 0');
  });

  it('renders an error state (data-testid="list-view-error") when the query isError', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    } as unknown as UseQueryResult<QueryResult>);

    render(<ListView workspaceId={workspaceId} querySpec={querySpec} />);

    expect(screen.getByTestId('list-view-error')).toBeInTheDocument();
    expect(screen.queryAllByTestId('object-row')).toHaveLength(0);
  });

  // F1-T10 PR6c: rows become clickable-to-open. The row's title span is the
  // chosen affordance (data-testid="object-row-title", a keyboard-accessible
  // `role="button" tabIndex={0}` span mirroring EditableCell.tsx's display
  // span convention) — not the whole row — so a future "click elsewhere in
  // the row" affordance (e.g. a checkbox) can still be added later without
  // fighting this handler. `openObject` comes from the now-mocked
  // useObjectIdParam.ts.
  describe('opens the detail panel', () => {
    function mockSingleObject() {
      const objects = [
        {
          id: 'obj-1',
          title: 'Object 1',
          fieldValues: { status: 'todo' },
        } as unknown as ObjectWithFieldValues,
      ];
      mockedUseObjectsQuery.mockReturnValue({
        data: { objects },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as UseQueryResult<QueryResult>);
    }

    it('calls openObject(object.id) when the row title is clicked', async () => {
      const openObject = vi.fn();
      mockedUseObjectIdParam.mockReturnValue({
        objectId: undefined,
        openObject,
        closeObject: vi.fn(),
      });
      mockSingleObject();
      const user = userEvent.setup();

      render(<ListView workspaceId={workspaceId} querySpec={querySpec} />);

      await user.click(screen.getByTestId('object-row-title'));

      expect(openObject).toHaveBeenCalledWith('obj-1');
    });

    it('calls openObject(object.id) when Enter is pressed on the focused row title', async () => {
      const openObject = vi.fn();
      mockedUseObjectIdParam.mockReturnValue({
        objectId: undefined,
        openObject,
        closeObject: vi.fn(),
      });
      mockSingleObject();
      const user = userEvent.setup();

      render(<ListView workspaceId={workspaceId} querySpec={querySpec} />);

      screen.getByTestId('object-row-title').focus();
      await user.keyboard('{Enter}');

      expect(openObject).toHaveBeenCalledWith('obj-1');
    });
  });
});
