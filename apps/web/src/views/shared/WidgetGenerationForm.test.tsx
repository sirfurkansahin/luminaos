import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WidgetGenerationForm as WidgetGenerationFormModuleExport } from './WidgetGenerationForm.js';

import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar c/i, spec Kapsam madde
 * 5-7 + Kabul Kriterleri) -- TDD red step. Contract under test (neither
 * apps/web/src/views/shared/WidgetGenerationForm.tsx NOR its hook dependency
 * `useGenerateWidgetMutation` NOR its success-composed child
 * `LiveWidgetViewer` exist yet -- all three are new, this is the FIRST test
 * file to pin the form's own shape):
 *
 *   export interface WidgetGenerationFormProps { workspaceId: string; }
 *   export function WidgetGenerationForm(props: WidgetGenerationFormProps): React.JSX.Element;
 *
 * The spec's Kapsam madde 7 does not pin an explicit component name or file
 * split beyond "basit bir istek formu (prompt + hedef objectType + themePreset
 * seçimi)" -- this file names it `WidgetGenerationForm`, mirroring
 * `ArtifactGenerationForm`'s (F3-T7 PR3, merged) exact naming/structure
 * convention 1:1, since the spec explicitly says "spesifik UI konumu
 * implementer'ın kararı (F3-T7 PR3'ün AYNI serbestliği)".
 *
 * `objectType` design choice (spec/ADR leave this open -- documented here so
 * implementer matches exactly): a PLAIN TEXT `Input` (data-testid=
 * "widget-object-type-input"), not a `SelectRoot`. Rationale: `QuerySpec.
 * objectType`/`generate-widget.schema.ts`'s own `objectType` field is a bare
 * `string(1-100)` with NO fixed enum anywhere in the compile-widget-query
 * pipeline (ADR-0042 Karar c validates it server-side via `isKnownObjectType`,
 * not via a client-side enum) -- a free-text key entry (e.g. "task") is the
 * more honest mirror of that contract than inventing an arbitrary fixed
 * dropdown list this spec never pins.
 *
 * Contract pinned:
 * - `useGenerateWidgetMutation(workspaceId)` (mocked below, does not exist
 *   yet) is called with EXACTLY `workspaceId`.
 * - a prompt `Textarea` (data-testid="widget-prompt-input"), an `objectType`
 *   `Input` (data-testid="widget-object-type-input"), a `themePreset`
 *   `SelectRoot` (trigger data-testid="widget-theme-select", 3 options via
 *   data-testid="widget-theme-option-<preset>" for kurumsal/canli/minimal),
 *   and a submit `Button` (data-testid="widget-generate-submit").
 * - submit is disabled while the prompt is empty/whitespace-only, OR the
 *   objectType is empty/whitespace-only, OR the mutation isPending.
 * - while isPending, a pending indicator (data-testid="widget-generating")
 *   is shown.
 * - submitting calls the mutation's `mutate` with EXACTLY
 *   `{ prompt, objectType, themePreset }` reflecting the form's CURRENT
 *   values (default themePreset='kurumsal', until the user picks something
 *   else; prompt/objectType have no default -- both start empty, forcing
 *   the user to fill them before submit becomes enabled).
 * - when the mutation isError, renders an EmptyState
 *   (data-testid="widget-generate-error") without unmounting the form.
 * - once the mutation isSuccess and has `data`, renders the (mocked)
 *   `LiveWidgetViewer` with `workspaceId` and `artifactObjectId` equal to
 *   `data.object.id`.
 *
 * `./WidgetGenerationForm.tsx` does not exist yet, so this file is expected
 * to fail to even resolve that import until the component exists -- the
 * documented TDD red state.
 */

type ThemePresetName = 'kurumsal' | 'canli' | 'minimal';

interface WidgetObjectFixture {
  id: string;
  title: string;
  fieldValues: {
    htmlContent: string;
    themePreset: ThemePresetName;
    generationPrompt: string;
    artifactType: 'dashboard';
    querySpec: string;
  };
}

const { mockedUseGenerateWidgetMutation } = vi.hoisted(() => {
  return { mockedUseGenerateWidgetMutation: vi.fn() };
});

vi.mock('../../hooks/useGenerateWidgetMutation.js', () => ({
  useGenerateWidgetMutation: mockedUseGenerateWidgetMutation,
}));

interface CapturedLiveWidgetViewerProps {
  workspaceId: string;
  artifactObjectId: string;
}

const liveWidgetViewerState = vi.hoisted(() => ({
  calls: [] as CapturedLiveWidgetViewerProps[],
}));

vi.mock('./LiveWidgetViewer.js', () => ({
  LiveWidgetViewer: (props: CapturedLiveWidgetViewerProps) => {
    liveWidgetViewerState.calls.push(props);
    return (
      <div data-testid="mock-live-widget-viewer" data-artifact-object-id={props.artifactObjectId} />
    );
  },
}));

const WidgetGenerationForm = WidgetGenerationFormModuleExport;

const workspaceId = 'ws-1';

function makeGeneratedWidgetFixture(overrides: Partial<WidgetObjectFixture> = {}): {
  object: WidgetObjectFixture;
} {
  return {
    object: {
      id: 'widget-1',
      title: 'Gecikmiş Görevler',
      fieldValues: {
        htmlContent: '<!DOCTYPE html><html><body><table></table></body></html>',
        themePreset: 'kurumsal',
        generationPrompt: 'gecikmiş görevleri sorumluya göre göster',
        artifactType: 'dashboard',
        querySpec: JSON.stringify({ objectType: 'task', filters: [] }),
      },
      ...overrides,
    },
  };
}

function mockMutation(
  overrides: Partial<
    UseMutationResult<
      { object: WidgetObjectFixture },
      Error,
      { prompt: string; objectType: string; themePreset: ThemePresetName }
    >
  > = {},
): { mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn();
  mockedUseGenerateWidgetMutation.mockReturnValue({
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
  liveWidgetViewerState.calls.length = 0;
});

describe('WidgetGenerationForm', () => {
  it('sources identity only from the workspaceId prop -- the mutation hook is called with exactly that value', () => {
    mockMutation();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(mockedUseGenerateWidgetMutation).toHaveBeenCalledWith(workspaceId);
  });

  it('renders the prompt textarea, the objectType input, the theme select, and the submit button', () => {
    mockMutation();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('widget-prompt-input')).toBeInTheDocument();
    expect(screen.getByTestId('widget-object-type-input')).toBeInTheDocument();
    expect(screen.getByTestId('widget-theme-select')).toBeInTheDocument();
    expect(screen.getByTestId('widget-generate-submit')).toBeInTheDocument();
  });

  it('offers exactly the 3 themePreset options (kurumsal/canli/minimal)', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('widget-theme-select'));

    for (const preset of ['kurumsal', 'canli', 'minimal'] as const) {
      expect(screen.getByTestId(`widget-theme-option-${preset}`)).toBeInTheDocument();
    }
  });

  it('disables the submit button while both the prompt and objectType are empty', () => {
    mockMutation();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('widget-generate-submit')).toBeDisabled();
  });

  it('disables the submit button while the prompt is filled but objectType is empty', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('widget-prompt-input'), 'gecikmiş görevleri göster');

    expect(screen.getByTestId('widget-generate-submit')).toBeDisabled();
  });

  it('disables the submit button while objectType is filled but the prompt is empty', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('widget-object-type-input'), 'task');

    expect(screen.getByTestId('widget-generate-submit')).toBeDisabled();
  });

  it('disables the submit button while the prompt and objectType are only whitespace', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('widget-prompt-input'), '   ');
    await user.type(screen.getByTestId('widget-object-type-input'), '   ');

    expect(screen.getByTestId('widget-generate-submit')).toBeDisabled();
  });

  it('enables the submit button once both the prompt and objectType have non-whitespace content', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('widget-prompt-input'), 'gecikmiş görevleri göster');
    await user.type(screen.getByTestId('widget-object-type-input'), 'task');

    expect(screen.getByTestId('widget-generate-submit')).toBeEnabled();
  });

  it('submits { prompt, objectType, themePreset: "kurumsal" } by default (before the user touches the theme select)', async () => {
    const { mutate } = mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.type(
      screen.getByTestId('widget-prompt-input'),
      'gecikmiş görevleri sorumluya göre göster',
    );
    await user.type(screen.getByTestId('widget-object-type-input'), 'task');
    await user.click(screen.getByTestId('widget-generate-submit'));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      prompt: 'gecikmiş görevleri sorumluya göre göster',
      objectType: 'task',
      themePreset: 'kurumsal',
    });
  });

  it('submits the user-selected themePreset instead of the default', async () => {
    const { mutate } = mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('widget-prompt-input'), 'aylık KPI panosu üret');
    await user.type(screen.getByTestId('widget-object-type-input'), 'task');

    await user.click(screen.getByTestId('widget-theme-select'));
    await user.click(screen.getByTestId('widget-theme-option-canli'));

    await user.click(screen.getByTestId('widget-generate-submit'));

    expect(mutate).toHaveBeenCalledWith({
      prompt: 'aylık KPI panosu üret',
      objectType: 'task',
      themePreset: 'canli',
    });
  });

  it('does not call mutate when the submit button is clicked while disabled (no-op)', async () => {
    const { mutate } = mockMutation();
    const user = userEvent.setup();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('widget-generate-submit'));

    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows a pending indicator (data-testid="widget-generating") and disables submit while the mutation isPending', () => {
    mockMutation({ isPending: true });

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('widget-generating')).toBeInTheDocument();
    expect(screen.getByTestId('widget-generate-submit')).toBeDisabled();
  });

  it('does not show the pending indicator when the mutation is not pending', () => {
    mockMutation();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('widget-generating')).not.toBeInTheDocument();
  });

  it('renders a visible error block (data-testid="widget-generate-error") when the mutation isError, without unmounting the form', () => {
    mockMutation({ isError: true, error: new Error('Widget query compilation failed.') });

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('widget-generate-error')).toBeInTheDocument();
    expect(screen.getByTestId('widget-prompt-input')).toBeInTheDocument();
    expect(screen.getByTestId('widget-generate-submit')).toBeInTheDocument();
  });

  it('does not render the error block when the mutation is not in an error state', () => {
    mockMutation();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('widget-generate-error')).not.toBeInTheDocument();
  });

  it('renders LiveWidgetViewer with workspaceId and artifactObjectId=data.object.id once the mutation isSuccess', () => {
    const generated = makeGeneratedWidgetFixture({ id: 'widget-42' });
    mockMutation({ isSuccess: true, data: generated });

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('mock-live-widget-viewer')).toBeInTheDocument();
    expect(liveWidgetViewerState.calls).toHaveLength(1);
    expect(liveWidgetViewerState.calls[0]).toEqual({
      workspaceId,
      artifactObjectId: 'widget-42',
    });
  });

  it('does not render LiveWidgetViewer before any successful generation', () => {
    mockMutation();

    render(<WidgetGenerationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('mock-live-widget-viewer')).not.toBeInTheDocument();
    expect(liveWidgetViewerState.calls).toHaveLength(0);
  });
});
