import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeDeviation } from '@luminaos/artifacts';

import { BaselineViewer as BaselineViewerModuleExport } from './BaselineViewer.js';

import type { ObjectQueryResult } from '../../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues, QueryResult } from '../../lib/apiClient.js';

/**
 * F3-T10 PR3 (evrensel baseline/sapma motoru, frontend yarısı, ADR-0044
 * Karar h, spec Kabul Kriterleri) -- TDD red step. Contract under test
 * (apps/web/src/views/shared/BaselineViewer.tsx does not exist yet --
 * implementer must build it):
 *
 *   export interface BaselineViewerProps {
 *     workspaceId: string;
 *     artifactObjectId: string;
 *   }
 *   export function BaselineViewer(props: BaselineViewerProps): React.JSX.Element | null;
 *
 * IMPLEMENTATION-SHAPE CHOICE (documented here so implementer matches
 * exactly -- the brief left this open): per ADR-0044 Karar (h)'s own code
 * sketch, `BaselineViewer` calls `@tanstack/react-query`'s `useQuery` DIRECTLY
 * INLINE inside the component (NOT via a new dedicated hook file, unlike
 * `useLiveWidgetQuery.ts`). Rationale mirrored from the ADR: unlike
 * `WIDGET_REFRESH_INTERVAL_MS` (a constant reused nowhere else that
 * justified its own file), there is nothing baseline-comparison-specific to
 * extract into a separate hook module -- the `useQuery` call here has NO
 * `refetchInterval`/`refetchIntervalInBackground` options at all (that is
 * precisely the negative regression this file pins), so there is no shared
 * constant or reusable wrapper to name and export. Consequently this test
 * file uses `useLiveWidgetQuery.test.ts`'s EXACT
 * `vi.mock('@tanstack/react-query', ...)` wrapping technique (spread the
 * real module, replace only `useQuery` with `vi.fn(actual.useQuery)`) to
 * inspect the options object passed to that INLINE call, wrapping rendered
 * components in a real `QueryClientProvider` (this is a component test, not
 * a `renderHook` test, since `BaselineViewer` is a component).
 *
 * Per ADR-0044 Karar (h)'s own code sketch:
 *   - reads the artifact object via `useObjectQuery(workspaceId, artifactObjectId)`
 *     (mocked below -- this hook ALREADY exists in useObjectsQuery.ts).
 *   - parses `object.fieldValues.querySpec` with the SAME JSON.parse +
 *     `querySpecSchema.safeParse` fallback discipline as
 *     `LiveWidgetViewer.tsx`'s `parseQuerySpec` -- on ANY failure, renders a
 *     visible "karşılaştırma yapılamıyor" message (data-testid chosen here:
 *     "baseline-unavailable") WITHOUT crashing and WITHOUT calling
 *     `postObjectsQuery` at all.
 *   - when `querySpec` parses successfully, calls `postObjectsQuery` via the
 *     inline `useQuery` ONCE at mount -- `enabled: true`, but crucially NO
 *     `refetchInterval` (undefined or `false`, NEVER a numeric interval like
 *     `LiveWidgetViewer`'s 45000ms) -- plus a manual "Yenile" (refresh)
 *     button (data-testid="baseline-refresh-button") that calls the query's
 *     own `refetch()`.
 *   - computes `currentValue` via the REAL (un-mocked) `computeQueryAggregate`
 *     against the live query rows, then `deviation` via the REAL
 *     `computeDeviation({capturedValue, currentValue})` -- renders
 *     `capturedValue`/`currentValue`/`deviation.delta`/`deviation.percentChange`
 *     via the following data-testids (chosen here, none pinned by spec/ADR):
 *       - "baseline-captured-value"
 *       - "baseline-current-value"
 *       - "baseline-delta"
 *       - "baseline-percent-change"
 *   - when the live query response includes `nextCursor` (not all matching
 *     rows were seen -- ADR-0044 Karar e's sayfalama sınırı), renders a
 *     visible warning banner (data-testid="baseline-more-rows-warning").
 *
 * `@luminaos/artifacts`'s `computeQueryAggregate`/`computeDeviation` are
 * intentionally NOT mocked (real, PR1-merged, pure functions) -- this proves
 * genuine end-to-end computation inside `BaselineViewer`, not a stubbed
 * value, mirroring `LiveWidgetViewer.test.tsx`'s convention of exercising the
 * real `@luminaos/artifacts` pipeline rather than mocking it. The test
 * itself also imports the real `computeDeviation` to derive its OWN expected
 * delta/percentChange, so the assertion can never drift from the
 * implementation's own rounding/formatting choices as long as round numbers
 * are used in the fixture (they are, deliberately: capturedValue=10,
 * 15 live rows -> delta=5, percentChange=50, both exact integers).
 */

const { mockedUseObjectQuery } = vi.hoisted(() => ({ mockedUseObjectQuery: vi.fn() }));

vi.mock('../../hooks/useObjectsQuery.js', () => ({
  useObjectQuery: mockedUseObjectQuery,
}));

vi.mock('../../lib/apiClient.js', () => ({
  postObjectsQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
  };
});

// Imported AFTER the vi.mock calls above so the mocked bindings are used.
// eslint-disable-next-line import-x/order -- mocked module must be imported after vi.mock setup
import { postObjectsQuery } from '../../lib/apiClient.js';

const mockedPostObjectsQuery = vi.mocked(postObjectsQuery);
const mockedUseQuery = vi.mocked(useQuery);

interface UseQueryOptionsShape {
  enabled?: boolean;
  refetchInterval?: number | false;
}

function lastUseQueryOptions(): UseQueryOptionsShape | undefined {
  const lastCall = mockedUseQuery.mock.calls.at(-1);
  return lastCall?.[0] as UseQueryOptionsShape | undefined;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { Wrapper };
}

const BaselineViewer = BaselineViewerModuleExport;

const workspaceId = 'ws-1';
const artifactObjectId = 'baseline-1';

const CAPTURED_VALUE = 10;
const LIVE_ROW_COUNT = 15;
const expectedDeviation = computeDeviation({
  capturedValue: CAPTURED_VALUE,
  currentValue: LIVE_ROW_COUNT,
});

const VALID_QUERY_SPEC = { objectType: 'task', filters: [] };

function makeBaselineObjectFixture(
  fieldValueOverrides: Record<string, unknown> = {},
): ObjectWithFieldValues {
  return {
    id: artifactObjectId,
    workspaceId,
    type: 'artifact',
    title: 'Aktif Görev Sayısı',
    createdBy: 'user-1',
    createdAt: new Date('2026-09-12T00:00:00.000Z'),
    updatedAt: new Date('2026-09-12T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {
      artifactType: 'baseline',
      querySpec: JSON.stringify(VALID_QUERY_SPEC),
      aggregateFn: 'count',
      capturedValue: CAPTURED_VALUE,
      ...fieldValueOverrides,
    },
  } as unknown as ObjectWithFieldValues;
}

function mockObjectQuery(object: ObjectWithFieldValues | undefined): void {
  mockedUseObjectQuery.mockReturnValue({
    data: object ? { object } : undefined,
    isLoading: object === undefined,
    isError: false,
    error: null,
  } satisfies ObjectQueryResult);
}

function makeLiveRows(count: number): ObjectWithFieldValues[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `row-${String(index)}`,
        title: `Satır ${String(index)}`,
        fieldValues: {},
      }) as unknown as ObjectWithFieldValues,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('BaselineViewer', () => {
  it('renders capturedValue, currentValue, delta and percentChange computed via the real @luminaos/artifacts pipeline', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(LIVE_ROW_COUNT),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(screen.getByTestId('baseline-current-value')).toHaveTextContent(
        String(LIVE_ROW_COUNT),
      );
    });

    expect(screen.getByTestId('baseline-captured-value')).toHaveTextContent(String(CAPTURED_VALUE));
    expect(screen.getByTestId('baseline-delta')).toHaveTextContent(String(expectedDeviation.delta));
    expect(screen.getByTestId('baseline-percent-change')).toHaveTextContent(
      String(expectedDeviation.percentChange),
    );
  });

  it('calls postObjectsQuery exactly once at mount, never automatically again (no polling)', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(mockedPostObjectsQuery).toHaveBeenCalledTimes(1);
    });
  });

  it('never sets a numeric refetchInterval on the underlying useQuery call -- the exact opposite of useLiveWidgetQuery.ts (45s polling) regression', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(mockedUseQuery).toHaveBeenCalled();
    });

    const refetchInterval = lastUseQueryOptions()?.refetchInterval;
    expect(refetchInterval === undefined || refetchInterval === false).toBe(true);
  });

  it('clicking the manual refresh button ("Yenile") triggers a second postObjectsQuery call', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValue({ objects: makeLiveRows(1) } satisfies QueryResult);
    const { Wrapper } = createWrapper();
    const user = userEvent.setup();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(mockedPostObjectsQuery).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByTestId('baseline-refresh-button'));

    await waitFor(() => {
      expect(mockedPostObjectsQuery).toHaveBeenCalledTimes(2);
    });
  });

  it('renders a visible "karşılaştırma yapılamıyor" message without crashing, and never calls postObjectsQuery, when the stored querySpec is not valid JSON', () => {
    mockObjectQuery(makeBaselineObjectFixture({ querySpec: 'not-json{' }));
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('baseline-unavailable')).toBeInTheDocument();
    expect(screen.getByText(/karşılaştırma yapılamıyor/i)).toBeInTheDocument();
    expect(mockedPostObjectsQuery).not.toHaveBeenCalled();
  });

  it('renders the same "karşılaştırma yapılamıyor" fallback, without calling postObjectsQuery, when the stored querySpec is valid JSON but fails querySpecSchema validation', () => {
    // Missing the required `filters` array -- schema-invalid, not JSON-invalid.
    mockObjectQuery(
      makeBaselineObjectFixture({ querySpec: JSON.stringify({ objectType: 'task' }) }),
    );
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('baseline-unavailable')).toBeInTheDocument();
    expect(mockedPostObjectsQuery).not.toHaveBeenCalled();
  });

  it('renders a "more rows" warning banner when the live query response includes nextCursor (not all matching rows were aggregated)', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
      nextCursor: 'cursor-abc',
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(screen.getByTestId('baseline-more-rows-warning')).toBeInTheDocument();
    });
  });

  it('does not render the "more rows" warning banner when nextCursor is absent', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(mockedPostObjectsQuery).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByTestId('baseline-more-rows-warning')).not.toBeInTheDocument();
  });

  it('renders nothing while the underlying artifact object has not loaded yet', () => {
    mockObjectQuery(undefined);
    const { Wrapper } = createWrapper();

    const { container } = render(
      <BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />,
      { wrapper: Wrapper },
    );

    expect(container).toBeEmptyDOMElement();
    expect(mockedPostObjectsQuery).not.toHaveBeenCalled();
  });
});
