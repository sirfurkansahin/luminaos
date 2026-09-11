import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactGenerationForm as ArtifactGenerationFormModuleExport } from './ArtifactGenerationForm.js';

import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T7 PR3 (artifact boru hattı, ADR-0041 Karar c/d/h, spec Kabul
 * Kriterleri) — TDD red step. Contract under test (not yet implemented —
 * implementer must build apps/web/src/views/shared/ArtifactGenerationForm.tsx
 * to satisfy these tests):
 *
 *   export interface ArtifactGenerationFormProps { workspaceId: string; }
 *   export function ArtifactGenerationForm(props: ArtifactGenerationFormProps): React.JSX.Element;
 *
 * Per the spec's PR3 description ("basit bir üretim formu (prompt +
 * artifactType + themePreset seçimi)" as one piece + "üretilen artifact'ı
 * ArtifactViewer ile gösteren bir görünüm" as a SEPARATE piece), this is the
 * generation-form half; it composes the (separately tested)
 * `ArtifactViewer` component once a generation succeeds -- it does NOT
 * duplicate ArtifactViewer's own sandboxed-iframe contract here (that's
 * ArtifactViewer.test.tsx's job), it only asserts that the right
 * `htmlContent` is handed down once `useGenerateArtifactMutation`'s `data`
 * becomes available.
 *
 * Contract pinned:
 * - `useGenerateArtifactMutation(workspaceId)` (mocked below, does not exist
 *   yet) is called with EXACTLY `workspaceId`.
 * - a prompt `Textarea` (data-testid="artifact-prompt-input"), an
 *   `artifactType` `SelectRoot` (trigger data-testid="artifact-type-select",
 *   4 options via data-testid="artifact-type-option-<type>" for
 *   presentation/dashboard/page/report), a `themePreset` `SelectRoot`
 *   (trigger data-testid="artifact-theme-select", 3 options via
 *   data-testid="artifact-theme-option-<preset>" for
 *   kurumsal/canli/minimal), and a submit `Button`
 *   (data-testid="artifact-generate-submit").
 * - submit is disabled while the prompt is empty/whitespace-only, and while
 *   the mutation isPending.
 * - while isPending, a pending indicator (data-testid="artifact-generating")
 *   is shown.
 * - submitting calls the mutation's `mutate` with EXACTLY
 *   `{ prompt, artifactType, themePreset }` reflecting the form's CURRENT
 *   values (defaults: artifactType='presentation', themePreset='kurumsal',
 *   until the user picks something else).
 * - when the mutation isError, renders an EmptyState
 *   (data-testid="artifact-generate-error") without unmounting the form.
 * - once the mutation isSuccess and has `data`, renders the (mocked)
 *   `ArtifactViewer` with `htmlContent` equal to
 *   `data.object.fieldValues.htmlContent`.
 *
 * `./ArtifactGenerationForm.tsx` does not exist yet, so this file is
 * expected to fail to even resolve that import until the component exists —
 * the documented TDD red state.
 */

type ArtifactType = 'presentation' | 'dashboard' | 'page' | 'report';
type ThemePresetName = 'kurumsal' | 'canli' | 'minimal';

interface ObjectWithFieldValuesFixture {
  id: string;
  title: string;
  fieldValues: {
    htmlContent: string;
    themePreset: ThemePresetName;
    generationPrompt: string;
    artifactType: ArtifactType;
  };
}

const { mockedUseGenerateArtifactMutation } = vi.hoisted(() => {
  return { mockedUseGenerateArtifactMutation: vi.fn() };
});

vi.mock('../../hooks/useGenerateArtifactMutation.js', () => ({
  useGenerateArtifactMutation: mockedUseGenerateArtifactMutation,
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

const ArtifactGenerationForm = ArtifactGenerationFormModuleExport;

const workspaceId = 'ws-1';

function makeGeneratedObjectFixture(
  overrides: Partial<ObjectWithFieldValuesFixture['fieldValues']> = {},
): { object: ObjectWithFieldValuesFixture } {
  return {
    object: {
      id: 'artifact-1',
      title: 'Q3 Satış Sunumu',
      fieldValues: {
        htmlContent: '<!DOCTYPE html><html><body><h1>Q3</h1></body></html>',
        themePreset: 'kurumsal',
        generationPrompt: 'Q3 satış rakamlarını özetleyen bir sunum hazırla',
        artifactType: 'presentation',
        ...overrides,
      },
    },
  };
}

function mockMutation(
  overrides: Partial<
    UseMutationResult<
      { object: ObjectWithFieldValuesFixture },
      Error,
      { prompt: string; artifactType: ArtifactType; themePreset: ThemePresetName }
    >
  > = {},
): { mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn();
  mockedUseGenerateArtifactMutation.mockReturnValue({
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
  artifactViewerState.calls.length = 0;
});

describe('ArtifactGenerationForm', () => {
  it('sources identity only from the workspaceId prop -- the mutation hook is called with exactly that value', () => {
    mockMutation();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(mockedUseGenerateArtifactMutation).toHaveBeenCalledWith(workspaceId);
  });

  it('renders the prompt textarea, both selects, and the submit button', () => {
    mockMutation();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('artifact-prompt-input')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-type-select')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-theme-select')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-generate-submit')).toBeInTheDocument();
  });

  it('offers exactly the 4 artifactType options (presentation/dashboard/page/report)', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('artifact-type-select'));

    for (const type of ['presentation', 'dashboard', 'page', 'report'] as const) {
      expect(screen.getByTestId(`artifact-type-option-${type}`)).toBeInTheDocument();
    }
  });

  it('offers exactly the 3 themePreset options (kurumsal/canli/minimal)', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('artifact-theme-select'));

    for (const preset of ['kurumsal', 'canli', 'minimal'] as const) {
      expect(screen.getByTestId(`artifact-theme-option-${preset}`)).toBeInTheDocument();
    }
  });

  it('disables the submit button while the prompt is empty', () => {
    mockMutation();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('artifact-generate-submit')).toBeDisabled();
  });

  it('disables the submit button while the prompt is only whitespace', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('artifact-prompt-input'), '    ');

    expect(screen.getByTestId('artifact-generate-submit')).toBeDisabled();
  });

  it('enables the submit button once the prompt has non-whitespace content', async () => {
    mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.type(
      screen.getByTestId('artifact-prompt-input'),
      'Q3 satışlarını özetleyen bir sunum',
    );

    expect(screen.getByTestId('artifact-generate-submit')).toBeEnabled();
  });

  it('submits { prompt, artifactType: "presentation", themePreset: "kurumsal" } by default (before the user touches either select)', async () => {
    const { mutate } = mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('artifact-prompt-input'), 'Q3 satışlarını özetle');
    await user.click(screen.getByTestId('artifact-generate-submit'));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      prompt: 'Q3 satışlarını özetle',
      artifactType: 'presentation',
      themePreset: 'kurumsal',
    });
  });

  it('submits the user-selected artifactType and themePreset instead of the defaults', async () => {
    const { mutate } = mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.type(screen.getByTestId('artifact-prompt-input'), 'Aylık KPI panosu üret');

    await user.click(screen.getByTestId('artifact-type-select'));
    await user.click(screen.getByTestId('artifact-type-option-dashboard'));

    await user.click(screen.getByTestId('artifact-theme-select'));
    await user.click(screen.getByTestId('artifact-theme-option-canli'));

    await user.click(screen.getByTestId('artifact-generate-submit'));

    expect(mutate).toHaveBeenCalledWith({
      prompt: 'Aylık KPI panosu üret',
      artifactType: 'dashboard',
      themePreset: 'canli',
    });
  });

  it('does not call mutate when the submit button is clicked while the prompt is empty (disabled == no-op)', async () => {
    const { mutate } = mockMutation();
    const user = userEvent.setup();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('artifact-generate-submit'));

    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows a pending indicator (data-testid="artifact-generating") and disables submit while the mutation isPending', () => {
    mockMutation({ isPending: true });

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('artifact-generating')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-generate-submit')).toBeDisabled();
  });

  it('does not show the pending indicator when the mutation is not pending', () => {
    mockMutation();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('artifact-generating')).not.toBeInTheDocument();
  });

  it('renders a visible error block (data-testid="artifact-generate-error") when the mutation isError, without unmounting the form', () => {
    mockMutation({ isError: true, error: new Error('Artifact generation failed') });

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('artifact-generate-error')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-prompt-input')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-generate-submit')).toBeInTheDocument();
  });

  it('does not render the error block when the mutation is not in an error state', () => {
    mockMutation();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('artifact-generate-error')).not.toBeInTheDocument();
  });

  it('renders ArtifactViewer with htmlContent from data.object.fieldValues.htmlContent once the mutation isSuccess', () => {
    const generated = makeGeneratedObjectFixture({
      htmlContent: '<!DOCTYPE html><html><body><h1>Üretilen İçerik</h1></body></html>',
    });
    mockMutation({ isSuccess: true, data: generated });

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.getByTestId('mock-artifact-viewer')).toBeInTheDocument();
    expect(artifactViewerState.calls).toHaveLength(1);
    expect(artifactViewerState.calls[0]?.htmlContent).toBe(
      generated.object.fieldValues.htmlContent,
    );
  });

  it('does not render ArtifactViewer before any successful generation', () => {
    mockMutation();

    render(<ArtifactGenerationForm workspaceId={workspaceId} />);

    expect(screen.queryByTestId('mock-artifact-viewer')).not.toBeInTheDocument();
    expect(artifactViewerState.calls).toHaveLength(0);
  });
});
