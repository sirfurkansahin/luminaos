import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { TimelineView } from './TimelineView.js';
import { useObjectsQuery } from '../hooks/useObjectsQuery.js';
import { addDays, getTodayDateOnly, toISODate } from '../lib/dateMath.js';

import type { ObjectWithFieldValues, QueryResult } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Mirrors CalendarView.test.tsx's mocking approach: only
 * `../hooks/useObjectsQuery.js` is mocked wholesale — no `@dnd-kit/core` mock
 * needed since Timeline has no drag-and-drop.
 *
 * Field keys are deliberately named `begin`/`finish` (rather than
 * `start`/`end`) so that `detectDateFieldCandidates`' alphabetical sort
 * ('begin' < 'finish') lines up with the intended start/end semantics —
 * TimelineView defaults `startField`/`endField` to `candidates[0]`/`[1]`.
 */

vi.mock('../hooks/useObjectsQuery.js', () => ({
  useObjectsQuery: vi.fn(),
}));

const mockedUseObjectsQuery = vi.mocked(useObjectsQuery);

const workspaceId = 'ws-1';
const objectType = 'task';

function isBootstrapQuerySpec(querySpec: QuerySpec): boolean {
  return querySpec.filters.length === 0;
}

function mockQueries(bootstrap: QueryResult | undefined, main: QueryResult | undefined): void {
  mockedUseObjectsQuery.mockImplementation((_workspaceId: string, querySpec: QuerySpec) => {
    const data = isBootstrapQuerySpec(querySpec) ? bootstrap : main;
    return {
      data,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>;
  });
}

function makeObject(
  id: string,
  beginDate: string,
  finishDate: string,
  title = `Object ${id}`,
): ObjectWithFieldValues {
  return {
    id,
    title,
    fieldValues: { begin: beginDate, finish: finishDate },
  } as unknown as ObjectWithFieldValues;
}

function lastMainQuerySpec(): QuerySpec | undefined {
  const mainCalls = mockedUseObjectsQuery.mock.calls.filter(
    ([, querySpec]) => !isBootstrapQuerySpec(querySpec),
  );
  return mainCalls[mainCalls.length - 1]?.[1];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TimelineView', () => {
  it('renders a loading state (data-testid="timeline-view-loading") while the bootstrap query is loading', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<QueryResult>);

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('timeline-view-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="timeline-view-error") when the bootstrap query isError', () => {
    mockedUseObjectsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    } as unknown as UseQueryResult<QueryResult>);

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('timeline-view-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="timeline-view-empty") when fewer than two date-like fields are found', () => {
    mockQueries(
      {
        objects: [
          {
            id: 'o1',
            title: 'X',
            fieldValues: { begin: '2026-03-01' },
          } as unknown as ObjectWithFieldValues,
        ],
      },
      undefined,
    );

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('timeline-view-empty')).toBeInTheDocument();
  });

  it('renders a start/end-dated object as a bar with the expected left/width position', () => {
    const today = getTodayDateOnly();
    const beginISO = toISODate(today);
    const finishISO = toISODate(addDays(today, 4));
    const obj = makeObject('obj-1', beginISO, finishISO);
    mockQueries({ objects: [obj] }, { objects: [obj] });

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    const bar = screen.getByTestId('timeline-bar');
    expect(bar).toHaveTextContent('Object obj-1');
    // anchor defaults to today -> begin offset 0, finish offset 4, pxPerDay 40.
    expect(bar.style.left).toBe('0px');
    expect(bar.style.width).toBe('160px');
  });

  it('clicking the Next button advances the queried range (new before/after boundary values)', async () => {
    const today = getTodayDateOnly();
    const beginISO = toISODate(today);
    const finishISO = toISODate(addDays(today, 4));
    const obj = makeObject('obj-1', beginISO, finishISO);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    const user = userEvent.setup();

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    const specBefore = lastMainQuerySpec();
    expect(specBefore).toBeDefined();

    await user.click(screen.getByTestId('timeline-nav-next'));

    const specAfter = lastMainQuerySpec();
    expect(specAfter).toBeDefined();
    expect(specAfter).not.toEqual(specBefore);
    expect(specAfter?.filters[0]?.value).not.toEqual(specBefore?.filters[0]?.value);
  });

  it('renders the today marker only while today falls within the visible window', async () => {
    const today = getTodayDateOnly();
    const beginISO = toISODate(today);
    const finishISO = toISODate(addDays(today, 4));
    const obj = makeObject('obj-1', beginISO, finishISO);
    mockQueries({ objects: [obj] }, { objects: [obj] });
    const user = userEvent.setup();

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    expect(screen.getByTestId('timeline-today-marker')).toBeInTheDocument();

    await user.click(screen.getByTestId('timeline-nav-next'));

    expect(screen.queryByTestId('timeline-today-marker')).not.toBeInTheDocument();
  });

  /**
   * F1-T9 PR2 addition: optional `initialStartField`/`initialEndField` props
   * seed the initially-selected start/end fields (used to restore a saved
   * view's stored `startField`/`endField` instead of always defaulting to
   * `candidates[0]`/`candidates[1]`). Three distinct date-like candidates are
   * seeded here (`begin`/`due`/`finish`, alphabetically `begin` < `due` <
   * `finish`) so the default (`candidates[0]`/`candidates[1]` ===
   * `begin`/`due`) and explicit overrides (`finish`/`begin`) are observably
   * different.
   */
  function makeThreeFieldObject(id: string): ObjectWithFieldValues {
    return {
      id,
      title: `Object ${id}`,
      fieldValues: { begin: '2026-01-01', due: '2026-01-03', finish: '2026-01-05' },
    } as unknown as ObjectWithFieldValues;
  }

  it("regression: with no initialStartField/initialEndField props, defaults to candidates[0]/candidates[1] (today's exact default behavior)", () => {
    const obj = makeThreeFieldObject('obj-1');
    mockQueries({ objects: [obj] }, { objects: [obj] });

    render(<TimelineView workspaceId={workspaceId} objectType={objectType} />);

    const spec = lastMainQuerySpec();
    expect(spec?.filters[0]?.field).toBe('begin');
    expect(spec?.filters[1]?.field).toBe('due');
  });

  it('seeds the initially-selected start/end fields from initialStartField/initialEndField props', () => {
    const obj = makeThreeFieldObject('obj-1');
    mockQueries({ objects: [obj] }, { objects: [obj] });

    render(
      <TimelineView
        workspaceId={workspaceId}
        objectType={objectType}
        initialStartField="finish"
        initialEndField="begin"
      />,
    );

    const spec = lastMainQuerySpec();
    expect(spec?.filters[0]?.field).toBe('finish');
    expect(spec?.filters[1]?.field).toBe('begin');
    expect(screen.getByTestId('timeline-start-field-select')).toHaveTextContent('finish');
    expect(screen.getByTestId('timeline-end-field-select')).toHaveTextContent('begin');
  });
});
