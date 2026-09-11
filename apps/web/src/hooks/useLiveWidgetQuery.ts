import { useQuery } from '@tanstack/react-query';

import type { QuerySpec } from '@luminaos/shared';

import { postObjectsQuery } from '../lib/apiClient.js';

import type { QueryResult } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar e, insan kararı 4) -- the
 * live widget refresh interval, within the ADR-mandated 30s-60s window.
 */
export const WIDGET_REFRESH_INTERVAL_MS = 45_000;

/**
 * Thin polling wrapper around `postObjectsQuery`, mirroring
 * `useObjectsQuery.ts`'s `useObjectQuery`'s `enabled` convention. Disabled
 * (and never fetches) while `querySpec` is `undefined` -- the caller
 * (`LiveWidgetViewer`) passes `undefined` whenever the stored `querySpec`
 * fails to parse/validate.
 */
export function useLiveWidgetQuery(
  workspaceId: string,
  querySpec: QuerySpec | undefined,
): UseQueryResult<QueryResult> {
  return useQuery({
    queryKey: ['liveWidget', workspaceId, querySpec],
    queryFn: () => postObjectsQuery(workspaceId, querySpec as QuerySpec),
    enabled: querySpec !== undefined,
    refetchInterval: WIDGET_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}
