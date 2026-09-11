import { useState } from 'react';

import {
  Button,
  EmptyState,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@luminaos/ui';

import { ArtifactViewer } from './ArtifactViewer.js';
import { useGenerateArtifactMutation } from '../../hooks/useGenerateArtifactMutation.js';

import type { ArtifactType, ThemePresetName } from '../../lib/apiClient.js';

/**
 * F3-T7 PR3 (artifact boru hattı, ADR-0041 Karar c/d/h, spec Kabul
 * Kriterleri) -- basit üretim formu (prompt + artifactType + themePreset
 * seçimi) + üretilen artifact'ı `ArtifactViewer` ile gösteren görünüm.
 */
export interface ArtifactGenerationFormProps {
  workspaceId: string;
}

const ARTIFACT_TYPE_OPTIONS: { value: ArtifactType; label: string }[] = [
  { value: 'presentation', label: 'Sunum' },
  { value: 'dashboard', label: 'Pano' },
  { value: 'page', label: 'Sayfa' },
  { value: 'report', label: 'Rapor' },
];

const THEME_PRESET_OPTIONS: { value: ThemePresetName; label: string }[] = [
  { value: 'kurumsal', label: 'Kurumsal' },
  { value: 'canli', label: 'Canlı' },
  { value: 'minimal', label: 'Minimal' },
];

export function ArtifactGenerationForm({ workspaceId }: ArtifactGenerationFormProps) {
  const [prompt, setPrompt] = useState('');
  const [artifactType, setArtifactType] = useState<ArtifactType>('presentation');
  const [themePreset, setThemePreset] = useState<ThemePresetName>('kurumsal');

  const mutation = useGenerateArtifactMutation(workspaceId);

  const isSubmitDisabled = prompt.trim().length === 0 || mutation.isPending;

  function handleSubmit(): void {
    if (isSubmitDisabled) {
      return;
    }
    mutation.mutate({ prompt, artifactType, themePreset });
  }

  return (
    <div>
      <Textarea
        data-testid="artifact-prompt-input"
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
        }}
        placeholder="Üretmek istediğiniz artifact'ı tarif edin"
      />

      <SelectRoot
        value={artifactType}
        onValueChange={(next) => {
          setArtifactType(next as ArtifactType);
        }}
      >
        <SelectTrigger data-testid="artifact-type-select" aria-label="Artifact türü">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ARTIFACT_TYPE_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={`artifact-type-option-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>

      <SelectRoot
        value={themePreset}
        onValueChange={(next) => {
          setThemePreset(next as ThemePresetName);
        }}
      >
        <SelectTrigger data-testid="artifact-theme-select" aria-label="Tema">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THEME_PRESET_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={`artifact-theme-option-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>

      <Button
        data-testid="artifact-generate-submit"
        disabled={isSubmitDisabled}
        onClick={handleSubmit}
      >
        Oluştur
      </Button>

      {mutation.isPending ? <div data-testid="artifact-generating">Oluşturuluyor…</div> : null}

      {mutation.isError ? (
        <EmptyState
          data-testid="artifact-generate-error"
          title="Artifact oluşturulamadı"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      {mutation.isSuccess && typeof mutation.data.object.fieldValues.htmlContent === 'string' ? (
        <ArtifactViewer htmlContent={mutation.data.object.fieldValues.htmlContent} />
      ) : null}
    </div>
  );
}
