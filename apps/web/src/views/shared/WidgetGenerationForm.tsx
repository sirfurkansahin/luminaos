import { useState } from 'react';

import {
  Button,
  EmptyState,
  Input,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@luminaos/ui';

import { LiveWidgetViewer } from './LiveWidgetViewer.js';
import { useGenerateWidgetMutation } from '../../hooks/useGenerateWidgetMutation.js';

import type { ThemePresetName } from '../../lib/apiClient.js';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar c/i, spec Kapsam madde
 * 5-7 + Kabul Kriterleri) -- basit üretim formu (prompt + hedef objectType +
 * themePreset seçimi), mirroring `ArtifactGenerationForm`'s exact
 * structure/conventions. `objectType` is a plain text `Input` -- the
 * compile-widget-query pipeline validates it server-side via
 * `isKnownObjectType`, there is no fixed client-side enum to mirror.
 */
export interface WidgetGenerationFormProps {
  workspaceId: string;
}

const THEME_PRESET_OPTIONS: { value: ThemePresetName; label: string }[] = [
  { value: 'kurumsal', label: 'Kurumsal' },
  { value: 'canli', label: 'Canlı' },
  { value: 'minimal', label: 'Minimal' },
];

export function WidgetGenerationForm({ workspaceId }: WidgetGenerationFormProps) {
  const [prompt, setPrompt] = useState('');
  const [objectType, setObjectType] = useState('');
  const [themePreset, setThemePreset] = useState<ThemePresetName>('kurumsal');

  const mutation = useGenerateWidgetMutation(workspaceId);

  const isSubmitDisabled =
    prompt.trim().length === 0 || objectType.trim().length === 0 || mutation.isPending;

  function handleSubmit(): void {
    if (isSubmitDisabled) {
      return;
    }
    mutation.mutate({ prompt, objectType, themePreset });
  }

  return (
    <div>
      <Textarea
        data-testid="widget-prompt-input"
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
        }}
        placeholder="Üretmek istediğiniz widget'ı tarif edin"
      />

      <Input
        data-testid="widget-object-type-input"
        value={objectType}
        onChange={(event) => {
          setObjectType(event.target.value);
        }}
        placeholder="Hedef obje tipi (ör. task)"
      />

      <SelectRoot
        value={themePreset}
        onValueChange={(next) => {
          setThemePreset(next as ThemePresetName);
        }}
      >
        <SelectTrigger data-testid="widget-theme-select" aria-label="Tema">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THEME_PRESET_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={`widget-theme-option-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>

      <Button
        data-testid="widget-generate-submit"
        disabled={isSubmitDisabled}
        onClick={handleSubmit}
      >
        Oluştur
      </Button>

      {mutation.isPending ? <div data-testid="widget-generating">Oluşturuluyor…</div> : null}

      {mutation.isError ? (
        <EmptyState
          data-testid="widget-generate-error"
          title="Widget oluşturulamadı"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      {mutation.isSuccess ? (
        <LiveWidgetViewer workspaceId={workspaceId} artifactObjectId={mutation.data.object.id} />
      ) : null}
    </div>
  );
}
