import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveWidgetViewer as LiveWidgetViewerModuleExport } from './LiveWidgetViewer.js';

import type { ObjectQueryResult } from '../../hooks/useObjectsQuery.js';
import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar f, spec Kabul Kriterleri)
 * -- TDD red step. Contract under test (apps/web/src/views/shared/
 * LiveWidgetViewer.tsx does not exist yet -- implementer must build it,
 * plus its two hook dependencies mocked below):
 *
 *   export interface LiveWidgetViewerProps {
 *     workspaceId: string;
 *     artifactObjectId: string;
 *   }
 *   export function LiveWidgetViewer(props: LiveWidgetViewerProps): React.JSX.Element | null;
 *
 * Per ADR-0042 Karar (f)'s own code sketch:
 *   - reads the artifact object via `useObjectQuery(workspaceId, artifactObjectId)`
 *     (mocked below -- this hook ALREADY exists in useObjectsQuery.ts).
 *   - parses `object.fieldValues.querySpec` (a JSON-serialized `QuerySpec`
 *     string) with `JSON.parse` + `@luminaos/shared`'s `querySpecSchema.
 *     safeParse` -- on ANY failure (invalid JSON OR schema-invalid), falls
 *     back to `querySpec === undefined` WITHOUT crashing.
 *   - polls live rows via `useLiveWidgetQuery(workspaceId, querySpec)` (new
 *     hook, mocked below, not yet implemented -- see
 *     useLiveWidgetQuery.test.ts).
 *   - when `querySpec` is defined, computes `htmlContent` by calling
 *     `@luminaos/artifacts`'s `deriveWidgetColumns`/
 *     `buildQueryResultTableSection`/`renderArtifactHtml` (all pure,
 *     PR1-merged) against the LIVE query rows -- when `querySpec` is
 *     undefined (parse/schema failure), falls back to the object's OWN
 *     static `fieldValues.htmlContent` snapshot as-is.
 *   - renders the (mocked, child) `ArtifactViewer` with that `htmlContent`.
 *
 * This test file does NOT re-derive the exact expected HTML string via the
 * real `packages/artifacts` render pipeline (that pipeline's own
 * escaping/table-building contract is already covered by
 * `packages/artifacts`'s own PR1 test suite) -- it only asserts (a) the
 * live-path `htmlContent` differs from the stale static snapshot and
 * contains an easily-greppable marker unique to the live rows, and (b) the
 * fallback path returns the static snapshot UNCHANGED.
 *
 * `ArtifactViewer` (already merged, F3-T7 PR3) is mocked per this codebase's
 * established child-mocking convention (see
 * `ArtifactGenerationForm.test.tsx`'s identical `vi.mock('./ArtifactViewer.js', ...)`
 * pattern) -- this test never exercises ArtifactViewer's own sandboxed-
 * iframe contract, only what `htmlContent` prop it was handed.
 */

const { mockedUseObjectQuery } = vi.hoisted(() => ({ mockedUseObjectQuery: vi.fn() }));
const { mockedUseLiveWidgetQuery } = vi.hoisted(() => ({ mockedUseLiveWidgetQuery: vi.fn() }));

vi.mock('../../hooks/useObjectsQuery.js', () => ({
  useObjectQuery: mockedUseObjectQuery,
}));

vi.mock('../../hooks/useLiveWidgetQuery.js', () => ({
  useLiveWidgetQuery: mockedUseLiveWidgetQuery,
  WIDGET_REFRESH_INTERVAL_MS: 45_000,
}));

interface CapturedArtifactViewerProps {
  htmlContent: string;
}

const artifactViewerState = vi.hoisted(() => ({
  calls: [] as CapturedArtifactViewerProps[],
}));

vi.mock('./ArtifactViewer.js', () => ({
  ArtifactViewer: (props: CapturedArtifactViewerProps) => {
    artifactViewerState.calls.push(props);
    return <div data-testid="mock-artifact-viewer" data-html-content={props.htmlContent} />;
  },
}));

const LiveWidgetViewer = LiveWidgetViewerModuleExport;

const workspaceId = 'ws-1';
const artifactObjectId = 'widget-1';

const STATIC_FALLBACK_HTML =
  '<!DOCTYPE html><html><body><h1>Statik Anlık Görüntü</h1></body></html>';

const VALID_QUERY_SPEC = {
  objectType: 'task',
  filters: [{ field: 'assignee', operator: 'equals', value: 'user-1' }],
};

function makeWidgetObjectFixture(
  fieldValueOverrides: Record<string, unknown> = {},
): ObjectWithFieldValues {
  return {
    id: artifactObjectId,
    workspaceId,
    type: 'artifact',
    title: 'Gecikmiş Görevler',
    createdBy: 'user-1',
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {
      htmlContent: STATIC_FALLBACK_HTML,
      themePreset: 'kurumsal',
      generationPrompt: 'gecikmiş görevleri sorumluya göre göster',
      artifactType: 'dashboard',
      querySpec: JSON.stringify(VALID_QUERY_SPEC),
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

function mockLiveWidgetQuery(rowTitles: string[]): void {
  mockedUseLiveWidgetQuery.mockReturnValue({
    data: {
      objects: rowTitles.map(
        (title, index) =>
          ({
            id: `row-${String(index)}`,
            title,
            fieldValues: {},
          }) as unknown as ObjectWithFieldValues,
      ),
    },
    isError: false,
    error: null,
    isPending: false,
    isSuccess: true,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  artifactViewerState.calls.length = 0;
});

describe('LiveWidgetViewer', () => {
  it('parses the stored querySpec and polls useLiveWidgetQuery with it', () => {
    mockObjectQuery(makeWidgetObjectFixture());
    mockLiveWidgetQuery(['Rapor Hazırla EŞSİZ-CANLI-SATIR']);

    render(<LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />);

    expect(mockedUseObjectQuery).toHaveBeenCalledWith(workspaceId, artifactObjectId);
    expect(mockedUseLiveWidgetQuery).toHaveBeenCalledWith(workspaceId, VALID_QUERY_SPEC);
  });

  it('feeds ArtifactViewer fresh htmlContent reflecting live query rows, not the stale static snapshot', () => {
    mockObjectQuery(makeWidgetObjectFixture());
    mockLiveWidgetQuery(['Rapor Hazırla EŞSİZ-CANLI-SATIR']);

    render(<LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />);

    expect(artifactViewerState.calls).toHaveLength(1);
    const receivedHtml = artifactViewerState.calls[0]?.htmlContent;
    expect(receivedHtml).not.toBe(STATIC_FALLBACK_HTML);
    expect(receivedHtml).toContain('EŞSİZ-CANLI-SATIR');
  });

  it('falls back to the static htmlContent snapshot without crashing when the stored querySpec is not valid JSON', () => {
    mockObjectQuery(makeWidgetObjectFixture({ querySpec: 'not-json{' }));
    mockLiveWidgetQuery(['bu satır hiç görülmemeli']);

    render(<LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />);

    expect(artifactViewerState.calls).toHaveLength(1);
    expect(artifactViewerState.calls[0]?.htmlContent).toBe(STATIC_FALLBACK_HTML);
    expect(mockedUseLiveWidgetQuery).toHaveBeenCalledWith(workspaceId, undefined);
  });

  it('falls back to the static htmlContent snapshot without crashing when the stored querySpec is valid JSON but fails querySpecSchema validation', () => {
    // Missing the required `filters` array -- schema-invalid, not JSON-invalid.
    mockObjectQuery(makeWidgetObjectFixture({ querySpec: JSON.stringify({ objectType: 'task' }) }));
    mockLiveWidgetQuery(['bu satır hiç görülmemeli']);

    render(<LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />);

    expect(artifactViewerState.calls).toHaveLength(1);
    expect(artifactViewerState.calls[0]?.htmlContent).toBe(STATIC_FALLBACK_HTML);
    expect(mockedUseLiveWidgetQuery).toHaveBeenCalledWith(workspaceId, undefined);
  });

  it('updates the htmlContent fed to ArtifactViewer when useLiveWidgetQuery data changes between renders (simulated poll tick)', () => {
    mockObjectQuery(makeWidgetObjectFixture());
    mockLiveWidgetQuery(['İLK-TICK-SATIR']);

    const { rerender } = render(
      <LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />,
    );

    const firstHtml = artifactViewerState.calls.at(-1)?.htmlContent;
    expect(firstHtml).toContain('İLK-TICK-SATIR');

    mockLiveWidgetQuery(['IKINCI-TICK-SATIR']);
    rerender(<LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />);

    const secondHtml = artifactViewerState.calls.at(-1)?.htmlContent;
    expect(secondHtml).toContain('IKINCI-TICK-SATIR');
    expect(secondHtml).not.toBe(firstHtml);
  });

  it('renders nothing yet (no ArtifactViewer) while the underlying artifact object has not loaded', () => {
    mockObjectQuery(undefined);
    mockLiveWidgetQuery([]);

    render(<LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={artifactObjectId} />);

    expect(artifactViewerState.calls).toHaveLength(0);
  });
});
