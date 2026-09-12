import { useMutation, useQueryClient } from '@tanstack/react-query';

import { explainDeviation } from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T11 PR3 (sapma açıklama kartı, ADR-0045 Karar e/g) -- mirrors
 * `useCaptureBaselineMutation`'s exact structure, PLUS an `onSuccess` cache
 * invalidation of the single-object query, since `explainDeviation`'s result
 * changes the baseline artifact's OWN `fieldValues`
 * (`explanationSummary`/`explanationCauses`/`explanationGeneratedAt`), which
 * `useObjectQuery` (`./useObjectsQuery.ts`) caches under
 * `['object', workspaceId, objectId]`.
 */
export function useExplainDeviationMutation(
  workspaceId: string,
  artifactObjectId: string,
): UseMutationResult<{ object: ObjectWithFieldValues }, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => explainDeviation(workspaceId, artifactObjectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['object', workspaceId, artifactObjectId],
      });
    },
  });
}
