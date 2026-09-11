import { useMutation } from '@tanstack/react-query';

import { generateArtifact } from '../lib/apiClient.js';

import type { ArtifactType, ObjectWithFieldValues, ThemePresetName } from '../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T7 PR3 (artifact boru hattı, ADR-0041 Karar d/h) -- mirrors
 * `useSetAutonomyTierMutation`'s structure, minus any query invalidation:
 * there is no "list of artifacts" query for v0, the generation form's own
 * `mutation.data` holds the just-created object for immediate display.
 */
export function useGenerateArtifactMutation(
  workspaceId: string,
): UseMutationResult<
  { object: ObjectWithFieldValues },
  Error,
  { prompt: string; artifactType: ArtifactType; themePreset: ThemePresetName }
> {
  return useMutation({
    mutationFn: (variables: {
      prompt: string;
      artifactType: ArtifactType;
      themePreset: ThemePresetName;
    }) => generateArtifact(workspaceId, variables),
  });
}
