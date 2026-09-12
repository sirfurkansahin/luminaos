import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedView } from '@luminaos/core-objects';

import { BaselineCreationForm as BaselineCreationFormModuleExport } from './BaselineCreationForm.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T10 PR3 (evrensel baseline/sapma motoru, frontend yarısı, ADR-0044
 * Karar d/h, spec Kabul Kriterleri) -- TDD red step. Contract under test
 * (NEITHER apps/web/src/views/shared/BaselineCreationForm.tsx NOR its hook
 * dependency `useCaptureBaselineMutation` exist yet -- both new, this is the
 * FIRST test file to pin the form's own shape), mirroring
 * `WidgetGenerationForm.tsx`/`.test.tsx`'s exact structure/conventions
 * (F3-T8 PR3, merged) 1:1 where the brief does not diverge:
 *
 *   export interface BaselineCreationFormProps { workspaceId: string; }
 *   export function BaselineCreationForm(props: BaselineCreationFormProps): React.JSX.Element;
 *
 * ADR-0044 Karar (d) is the load-bearing constraint this form encodes: the
 * user does NOT write a `QuerySpec` from scratch -- they pick an EXISTING
 * `SavedView` (via the ALREADY-EXISTING `useSavedViewsQuery(workspaceId,
 * objectType)`, mocked below), and the form derives the full `QuerySpec` to
 * submit as `{...selectedSavedView.querySpec, objectType: selectedSavedView.
 * objectType}` -- note this EXPLICITLY OVERRIDES whatever `objectType` the
 * saved view's OWN `querySpec` object might independently carry (defensive,
 * matches Karar d's code sketch verbatim) -- this file's fixture
 * deliberately sets the saved view's `querySpec.objectType` to a DIFFERENT,
 * stale string than `savedView.objectType` to prove the override, not just a
 * pass-through.
 *
 * `objectType` design choice (mirrors `WidgetGenerationForm`'s IDENTICAL
 * rationale, spec says nothing more specific): a PLAIN TEXT `Input`
 * (data-testid="baseline-object-type-input"), not a `SelectRoot` -- there is
 * no fixed client-side enum of object types anywhere in this pipeline,
 * `useSavedViewsQuery` itself requires a bare `objectType: string` to know
 * which workspace's `SavedView` list to fetch (server-side
 * `GET /workspaces/:workspaceId/views?objectType=...`).
 *
 * DEFAULT `aggregateFn` CHOICE (spec/ADR leave the default open -- documented
 * here so implementer matches exactly): `'count'`, the ONLY one of the 7
 * `AggregateFn` values that does NOT require a `targetFieldKey`
 * (`packages/artifacts/src/compute-query-aggregate.ts`'s own
 * `FIELD_REQUIRED_AGGREGATE_FNS` set) -- letting the user submit with zero
 * extra typing once a title + SavedView are chosen, the same "safe minimal
 * default" spirit as `WidgetGenerationForm`'s `themePreset:'kurumsal'`
 * default.
 *
 * CLIENT-SIDE PRE-VALIDATION (mirrors the spec's own instruction): submit is
 * disabled while `title` is empty, OR no `SavedView` is selected, OR the
 * selected `aggregateFn` is in `FIELD_REQUIRED_AGGREGATE_FNS`
 * ('sum'|'avg'|'min'|'max'|'countUnique'|'countEmpty') AND `targetFieldKey`
 * is empty/whitespace-only, OR the mutation `isPending` -- the SAME rule the
 * backend's `computeQueryAggregate` enforces (ADR-0044 Karar e), duplicated
 * client-side only for instant feedback (never the sole source of truth).
 *
 * Data-testids pinned by this file (none pre-existing elsewhere, chosen here
 * so implementer matches exactly):
 *   - "baseline-title-input" (Input)
 *   - "baseline-object-type-input" (Input, plain text)
 *   - "baseline-saved-view-select" (SelectRoot trigger) +
 *     "baseline-saved-view-option-<id>" (SelectItem per fetched SavedView)
 *   - "baseline-aggregate-fn-select" (SelectRoot trigger) +
 *     "baseline-aggregate-fn-option-<fn>" (SelectItem, one per the 7
 *     AggregateFn values, Turkish labels per ADR-0044 Karar (b)'s own seed
 *     code: sum="Toplam", avg="Ortalama", min="Minimum", max="Maksimum",
 *     count="Sayım", countUnique="Benzersiz Sayım", countEmpty="Boş Sayım")
 *   - "baseline-target-field-key-input" (Input, optional text)
 *   - "baseline-capture-submit" (Button)
 *   - "baseline-capturing" (pending indicator)
 *   - "baseline-capture-error" (EmptyState error block)
 *
 * On success (`mutation.isSuccess && mutation.data`), composes a MOCKED
 * `BaselineViewer` (does not exist yet either -- mocked wholesale below,
 * same as `WidgetGenerationForm.test.tsx` mocks its not-yet-existing
 * `LiveWidgetViewer` child) with `workspaceId` + `artifactObjectId =
 * mutation.data.object.id`.
 */

const { mockedUseSavedViewsQuery } = vi.hoisted(() => ({ mockedUseSavedViewsQuery: vi.fn() }));
const { mockedUseCaptureBaselineMutation } = vi.hoisted(() => ({
  mockedUseCaptureBaselineMutation: vi.fn(),
}));

vi.mock('../../hooks/useSavedViewsQuery.js', () => ({
  useSavedViewsQuery: mockedUseSavedViewsQuery,
}));

vi.mock('../../hooks/useCaptureBaselineMutation.js', () => ({
  useCaptureBaselineMutation: mockedUseCaptureBaselineMutation,
}));

interface CapturedBaselineViewerProps {
  workspaceId: string;
  artifactObjectId: string;
}

const baselineViewerState = vi.hoisted(() => ({
  calls: [] as CapturedBaselineViewerProps[],
}));

vi.mock('./BaselineViewer.js', () => ({
  BaselineViewer: (props: CapturedBaselineViewerProps) => {
    baselineViewerState.calls.push(props);
    return (
      <div data-testid="mock-baseline-viewer" data-artifact-object-id={props.artifactObjectId} />
    );
  },
}));

const BaselineCreationForm = BaselineCreationFormModuleExport;

const workspaceId = 'ws-1';

type AggregateFnFixture = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countUnique' | 'countEmpty';

const AGGREGATE_FN_LABELS: Record<AggregateFnFixture, string> = {
  sum: 'Toplam',
  avg: 'Ortalama',
  min: 'Minimum',
  max: 'Maksimum',
  count: 'Sayım',
  countUnique: 'Benzersiz Sayım',
  countEmpty: 'Boş Sayım',
};

const savedViewFixture: SavedView = {
  id: 'view-1',
  workspaceId,
  objectType: 'task',
  name: 'Açık Görevler',
  icon: '📋',
  viewType: 'table',
  // `querySpec.objectType` is DELIBERATELY a stale/different value than the
  // saved view's own top-level `objectType` -- proves the form's merge
  // OVERRIDES it with `savedView.objectType` (ADR-0044 Karar d), rather than
  // passing the saved view's `querySpec` through unchanged.
  querySpec: {
    objectType: 'stale-object-type-in-query-spec',
    filters: [{ field: 'status', operator: 'equals', value: 'open' }],
  },
  ownerId: 'user-1',
  lifecycle: 'active',
  createdAt: new Date('2026-09-12T00:00:00.000Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z'),
};

function mockSavedViews(savedViews: SavedView[]): void {
  mockedUseSavedViewsQuery.mockReturnValue({
    data: { savedViews },
    isLoading: false,
    isError: false,
    error: null,
  });
}

function makeCreatedBaselineFixture(overrides: Partial<ObjectWithFieldValues> = {}): {
  object: ObjectWithFieldValues;
} {
  return {
    object: {
      id: 'baseline-1',
      workspaceId,
      type: 'artifact',
      title: 'Açık Görev Sayısı',
      createdBy: 'user-1',
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
      updatedAt: new Date('2026-09-12T00:00:00.000Z'),
      lifecycle: 'active',
      checklist: [],
      fieldValues: {
        artifactType: 'baseline',
        querySpec: JSON.stringify({ objectType: 'task', filters: [] }),
        aggregateFn: 'count',
        capturedValue: 3,
      },
      ...overrides,
    } as unknown as ObjectWithFieldValues,
  };
}

function mockMutation(
  overrides: Partial<
    UseMutationResult<
      { object: ObjectWithFieldValues },
      Error,
      {
        title: string;
        querySpec: unknown;
        aggregateFn: AggregateFnFixture;
        targetFieldKey?: string;
      }
    >
  > = {},
): { mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn();
  mockedUseCaptureBaselineMutation.mockReturnValue({
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

afterEach(() => {
  vi.clearAllMocks();
  baselineViewerState.calls.length = 0;
});

describe('BaselineCreationForm', () => {
  it('sources identity only from the workspaceId prop -- the mutation hook is called with exactly that value', () => {
    mockMutation();
    mockSavedViews([]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(mockedUseCaptureBaselineMutation).toHaveBeenCalledWith(workspaceId);
  });

  it('calls useSavedViewsQuery with the workspaceId and the CURRENT objectType input value, starting empty', async () => {
    mockMutation();
    mockSavedViews([]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(mockedUseSavedViewsQuery).toHaveBeenLastCalledWith(workspaceId, '');

    await user.type(screen.getByTestId('baseline-object-type-input'), 'task');

    expect(mockedUseSavedViewsQuery).toHaveBeenLastCalledWith(workspaceId, 'task');
  });

  it('renders the title input, objectType input, saved-view select, aggregateFn select, targetFieldKey input, and submit button', () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('baseline-title-input')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-object-type-input')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-saved-view-select')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-aggregate-fn-select')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-target-field-key-input')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-capture-submit')).toBeInTheDocument();
  });

  it('offers one SavedView option per item returned by useSavedViewsQuery', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('baseline-saved-view-select'));

    expect(
      screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`),
    ).toHaveTextContent(savedViewFixture.name);
  });

  it('offers exactly the 7 aggregateFn options with the ADR-0044-mandated Turkish labels', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('baseline-aggregate-fn-select'));

    for (const [fn, label] of Object.entries(AGGREGATE_FN_LABELS)) {
      expect(screen.getByTestId(`baseline-aggregate-fn-option-${fn}`)).toHaveTextContent(label);
    }
  });

  it('disables submit while the title is empty, even with a SavedView selected', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));

    expect(screen.getByTestId('baseline-capture-submit')).toBeDisabled();
  });

  it('disables submit while no SavedView is selected, even with a title filled in', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Açık Görev Sayısı');

    expect(screen.getByTestId('baseline-capture-submit')).toBeDisabled();
  });

  it('disables submit when aggregateFn requires a targetFieldKey (e.g. "sum") and targetFieldKey is empty', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Toplam Süre');
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));
    await user.click(screen.getByTestId('baseline-aggregate-fn-select'));
    await user.click(screen.getByTestId('baseline-aggregate-fn-option-sum'));

    expect(screen.getByTestId('baseline-capture-submit')).toBeDisabled();
  });

  it('enables submit for the default "count" aggregateFn once title + SavedView are set, with no targetFieldKey required', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Açık Görev Sayısı');
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));

    expect(screen.getByTestId('baseline-capture-submit')).toBeEnabled();
  });

  it('enables submit for a field-required aggregateFn (e.g. "sum") once targetFieldKey is also filled in', async () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Toplam Süre');
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));
    await user.click(screen.getByTestId('baseline-aggregate-fn-select'));
    await user.click(screen.getByTestId('baseline-aggregate-fn-option-sum'));
    await user.type(screen.getByTestId('baseline-target-field-key-input'), 'estimatedHours');

    expect(screen.getByTestId('baseline-capture-submit')).toBeEnabled();
  });

  it('disables submit while the mutation isPending, even when the form is otherwise valid', async () => {
    mockMutation({ isPending: true });
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Açık Görev Sayısı');
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));

    expect(screen.getByTestId('baseline-capture-submit')).toBeDisabled();
  });

  it('submits {title, querySpec: {...savedView.querySpec, objectType: savedView.objectType}, aggregateFn: "count"} with NO targetFieldKey key when the default aggregateFn is used', async () => {
    const { mutate } = mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Açık Görev Sayısı');
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));
    await user.click(screen.getByTestId('baseline-capture-submit'));

    expect(mutate).toHaveBeenCalledTimes(1);
    const submitted = mutate.mock.calls[0]?.[0] as {
      title: string;
      querySpec: { objectType: string; filters: unknown[] };
      aggregateFn: string;
      targetFieldKey?: string;
    };
    expect(submitted).toEqual({
      title: 'Açık Görev Sayısı',
      querySpec: {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'equals', value: 'open' }],
      },
      aggregateFn: 'count',
    });
    expect(submitted.targetFieldKey).toBeUndefined();
    expect('targetFieldKey' in submitted).toBe(false);
  });

  it('submits the selected aggregateFn AND targetFieldKey when a field-required aggregateFn is chosen', async () => {
    const { mutate } = mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('baseline-title-input'), 'Toplam Süre');
    await user.click(screen.getByTestId('baseline-saved-view-select'));
    await user.click(screen.getByTestId(`baseline-saved-view-option-${savedViewFixture.id}`));
    await user.click(screen.getByTestId('baseline-aggregate-fn-select'));
    await user.click(screen.getByTestId('baseline-aggregate-fn-option-sum'));
    await user.type(screen.getByTestId('baseline-target-field-key-input'), 'estimatedHours');
    await user.click(screen.getByTestId('baseline-capture-submit'));

    expect(mutate).toHaveBeenCalledWith({
      title: 'Toplam Süre',
      querySpec: {
        objectType: 'task',
        filters: [{ field: 'status', operator: 'equals', value: 'open' }],
      },
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedHours',
    });
  });

  it('does not call mutate when the submit button is clicked while disabled (no-op)', async () => {
    const { mutate } = mockMutation();
    mockSavedViews([savedViewFixture]);
    const user = userEvent.setup();

    render(<BaselineCreationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('baseline-capture-submit'));

    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows a pending indicator (data-testid="baseline-capturing") while the mutation isPending', () => {
    mockMutation({ isPending: true });
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('baseline-capturing')).toBeInTheDocument();
  });

  it('does not show the pending indicator when the mutation is not pending', () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('baseline-capturing')).not.toBeInTheDocument();
  });

  it('renders a visible error block (data-testid="baseline-capture-error") when the mutation isError, without unmounting the form', () => {
    mockMutation({ isError: true, error: new Error('Baselines do not support grouped queries.') });
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('baseline-capture-error')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-title-input')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-capture-submit')).toBeInTheDocument();
  });

  it('does not render the error block when the mutation is not in an error state', () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('baseline-capture-error')).not.toBeInTheDocument();
  });

  it('renders BaselineViewer with workspaceId and artifactObjectId=data.object.id once the mutation isSuccess', () => {
    const created = makeCreatedBaselineFixture({
      id: 'baseline-42',
    });
    mockMutation({ isSuccess: true, data: created });
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('mock-baseline-viewer')).toBeInTheDocument();
    expect(baselineViewerState.calls).toHaveLength(1);
    expect(baselineViewerState.calls[0]).toEqual({
      workspaceId,
      artifactObjectId: 'baseline-42',
    });
  });

  it('does not render BaselineViewer before any successful capture', () => {
    mockMutation();
    mockSavedViews([savedViewFixture]);

    render(<BaselineCreationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('mock-baseline-viewer')).not.toBeInTheDocument();
    expect(baselineViewerState.calls).toHaveLength(0);
  });
});
