import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { computeDeviation } from '@luminaos/artifacts';

import { BaselineViewer as BaselineViewerModuleExport } from './BaselineViewer.js';

import type { ObjectQueryResult } from '../../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues, QueryResult } from '../../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

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

const { mockedUseObjectQuery, mockedUseExplainDeviationMutation } = vi.hoisted(() => ({
  mockedUseObjectQuery: vi.fn(),
  mockedUseExplainDeviationMutation: vi.fn(),
}));

vi.mock('../../hooks/useObjectsQuery.js', () => ({
  useObjectQuery: mockedUseObjectQuery,
}));

// F3-T11 PR3 (sapma açıklama kartı, ADR-0045 Karar e/g) -- a NEW hook,
// `apps/web/src/hooks/useExplainDeviationMutation.ts`, does not exist yet.
// Mocked wholesale here mirroring `WidgetGenerationForm.test.tsx`'s
// `useGenerateWidgetMutation` mocking convention exactly (vi.hoisted +
// vi.mock), since `BaselineViewer` is expected to call it directly (per the
// ADR's own code sketch, Karar g) rather than receiving it as a prop.
vi.mock('../../hooks/useExplainDeviationMutation.js', () => ({
  useExplainDeviationMutation: mockedUseExplainDeviationMutation,
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

// F3-T11 PR3 (sapma açıklama kartı, ADR-0045 Karar g) -- mirrors
// `WidgetGenerationForm.test.tsx`'s `mockMutation` helper exactly. The
// mutation under test takes NO variables (`mutate()` is called with zero
// arguments -- ADR-0045 Karar g's `onClick={() => explainMutation.mutate()}`).
function mockExplainMutation(
  overrides: Partial<UseMutationResult<{ object: ObjectWithFieldValues }, Error, void>> = {},
): { mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn();
  mockedUseExplainDeviationMutation.mockReturnValue({
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
    ...overrides,
  });
  return { mutate };
}

beforeEach(() => {
  // Sane, non-pending/non-error default so every EXISTING test above (which
  // predates this hook's existence and does not call mockExplainMutation
  // itself) keeps rendering correctly once BaselineViewer.tsx is extended to
  // call useExplainDeviationMutation unconditionally.
  mockExplainMutation();
});

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

/**
 * F3-T11 PR3 (sapma açıklama kartı, ADR-0045 Karar f/g, spec Kapsam madde 7 +
 * Kabul Kriterleri) -- TDD red step. `BaselineViewer.tsx` is NOT yet extended
 * with the "Açıklama iste"/"Yeniden oluştur" button + explanation card --
 * this whole block is expected to fail until the implementer adds:
 *   - a call to `useExplainDeviationMutation(workspaceId, artifactObjectId)`
 *     (mocked above via vi.mock('../../hooks/useExplainDeviationMutation.js')).
 *   - a button (data-testid="baseline-explain-button") whose label is
 *     "Açıklama iste" when `object.fieldValues.explanationSummary` is
 *     `undefined`, or "Yeniden oluştur" when it is a non-empty string; its
 *     onClick calls `explainMutation.mutate()` with NO arguments; it is
 *     `disabled` while `explainMutation.isPending`.
 *   - a pending indicator (data-testid="baseline-explain-loading") shown
 *     while `explainMutation.isPending` -- mirrors
 *     `WidgetGenerationForm.tsx`'s `data-testid="widget-generating"`
 *     convention 1:1 (ADR-0045 Karar g's own code sketch pins this exact
 *     testid).
 *   - an error block (data-testid="baseline-explain-error") shown while
 *     `explainMutation.isError` -- mirrors `WidgetGenerationForm.tsx`'s
 *     `EmptyState` `data-testid="widget-generate-error"` convention 1:1
 *     (ADR-0045 Karar g's own code sketch pins this exact testid).
 *   - when `explanationSummary` is set, a card (data-testid=
 *     "baseline-explanation-card") containing the summary text
 *     (data-testid="baseline-explanation-summary") and one list item per
 *     entry of `explanationCauses` (data-testid="baseline-explanation-cause"
 *     each) -- `explanationCauses` is a JSON-stringified string array parsed
 *     with the SAME "bozuksa sessizce undefined/[] dön" defensive discipline
 *     as this file's own `parseQuerySpec` (JSON.parse + safe fallback,
 *     NEVER throwing) -- malformed/non-JSON input renders the card with the
 *     summary but ZERO cause list items, never crashing.
 */
describe('BaselineViewer — açıklama iste / yeniden oluştur (F3-T11 PR3, ADR-0045 Karar f/g)', () => {
  it('renders the "baseline-explain-button" with the label "Açıklama iste" when no explanation has been generated yet', () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('baseline-explain-button')).toHaveTextContent('Açıklama iste');
  });

  it('renders the SAME button with the label "Yeniden oluştur", plus the explanation card with the summary text, once explanationSummary is a non-empty string', () => {
    mockObjectQuery(
      makeBaselineObjectFixture({
        explanationSummary: 'Bu ay tamamlanan görev sayısı belirgin şekilde arttı.',
      }),
    );
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('baseline-explain-button')).toHaveTextContent('Yeniden oluştur');
    expect(screen.getByTestId('baseline-explanation-card')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-explanation-summary')).toHaveTextContent(
      'Bu ay tamamlanan görev sayısı belirgin şekilde arttı.',
    );
  });

  it('renders one "baseline-explanation-cause" list item per entry of a JSON-stringified explanationCauses array', () => {
    mockObjectQuery(
      makeBaselineObjectFixture({
        explanationSummary: 'Özet metni.',
        explanationCauses: JSON.stringify(['Ekip büyüdü', 'Süreç iyileştirildi']),
      }),
    );
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    const causes = screen.getAllByTestId('baseline-explanation-cause');
    expect(causes).toHaveLength(2);
    expect(causes[0]).toHaveTextContent('Ekip büyüdü');
    expect(causes[1]).toHaveTextContent('Süreç iyileştirildi');
  });

  it('does not crash and renders the card with ZERO cause list items when explanationCauses is malformed/non-JSON', () => {
    mockObjectQuery(
      makeBaselineObjectFixture({
        explanationSummary: 'Özet metni.',
        explanationCauses: 'not json',
      }),
    );
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { Wrapper } = createWrapper();

    expect(() => {
      render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
        wrapper: Wrapper,
      });
    }).not.toThrow();

    expect(screen.getByTestId('baseline-explanation-card')).toBeInTheDocument();
    expect(screen.queryAllByTestId('baseline-explanation-cause')).toHaveLength(0);
  });

  it('calls the explain mutation with no arguments when the button is clicked', async () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    const { mutate } = mockExplainMutation();
    const { Wrapper } = createWrapper();
    const user = userEvent.setup();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });
    await user.click(screen.getByTestId('baseline-explain-button'));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith();
  });

  it('disables the explain button and shows a pending indicator while the explain mutation isPending', () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    mockExplainMutation({ isPending: true });
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('baseline-explain-button')).toBeDisabled();
    expect(screen.getByTestId('baseline-explain-loading')).toBeInTheDocument();
  });

  it('does not show the pending indicator when the explain mutation is not pending', () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    mockExplainMutation();
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.queryByTestId('baseline-explain-loading')).not.toBeInTheDocument();
  });

  it('renders a visible error block when the explain mutation isError', () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    mockExplainMutation({
      isError: true,
      error: new Error('Deviation explanation generation failed.'),
    });
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('baseline-explain-error')).toBeInTheDocument();
  });

  it('does not render the error block when the explain mutation is not in an error state', () => {
    mockObjectQuery(makeBaselineObjectFixture());
    mockedPostObjectsQuery.mockResolvedValueOnce({
      objects: makeLiveRows(1),
    } satisfies QueryResult);
    mockExplainMutation();
    const { Wrapper } = createWrapper();

    render(<BaselineViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />, {
      wrapper: Wrapper,
    });

    expect(screen.queryByTestId('baseline-explain-error')).not.toBeInTheDocument();
  });
});
