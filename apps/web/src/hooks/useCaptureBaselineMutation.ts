import { useMutation } from '@tanstack/react-query';

import type { AggregateFn } from '@luminaos/core-objects';
import type { QuerySpec } from '@luminaos/shared';

import { captureBaseline } from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T10 PR3 (evrensel baseline/sapma motoru, ADR-0044 Karar d/h) -- mirrors
 * `useGenerateWidgetMutation`'s exact structure, minus any query
 * invalidation: there is no "list of baselines" query for v0.
 */
export function useCaptureBaselineMutation(
  workspaceId: string,
): UseMutationResult<
  { object: ObjectWithFieldValues },
  Error,
  { title: string; querySpec: QuerySpec; aggregateFn: AggregateFn; targetFieldKey?: string }
> {
  return useMutation({
    mutationFn: (variables: {
      title: string;
      querySpec: QuerySpec;
      aggregateFn: AggregateFn;
      targetFieldKey?: string;
    }) => captureBaseline(workspaceId, variables),
  });
}
