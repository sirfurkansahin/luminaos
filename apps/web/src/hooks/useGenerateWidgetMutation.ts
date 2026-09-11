import { useMutation } from '@tanstack/react-query';

import { generateWidget } from '../lib/apiClient.js';

import type { ObjectWithFieldValues, ThemePresetName } from '../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar a) -- mirrors
 * `useGenerateArtifactMutation`'s structure, minus any query invalidation:
 * there is no "list of widgets" query for v0, the generation form's own
 * `mutation.data` holds the just-created object for immediate display.
 */
export function useGenerateWidgetMutation(
  workspaceId: string,
): UseMutationResult<
  { object: ObjectWithFieldValues },
  Error,
  { prompt: string; objectType: string; themePreset: ThemePresetName }
> {
  return useMutation({
    mutationFn: (variables: { prompt: string; objectType: string; themePreset: ThemePresetName }) =>
      generateWidget(workspaceId, variables),
  });
}
