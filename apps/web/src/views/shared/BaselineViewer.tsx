import { useQuery } from '@tanstack/react-query';

import { computeDeviation, computeQueryAggregate } from '@luminaos/artifacts';
import type { AggregateFn } from '@luminaos/core-objects';
import { querySpecSchema } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

import { useObjectQuery } from '../../hooks/useObjectsQuery.js';
import { postObjectsQuery } from '../../lib/apiClient.js';

/**
 * F3-T10 PR3 (evrensel baseline/sapma motoru, ADR-0044 Karar h) -- reads the
 * baseline artifact object, tries to parse+validate its stored `querySpec`
 * (mirrors `LiveWidgetViewer.tsx`'s `parseQuerySpec` exactly), and when that
 * succeeds runs the live comparison query ONCE at mount -- deliberately no
 * `refetchInterval`, unlike `useLiveWidgetQuery`'s 45s polling, since a
 * baseline comparison is refreshed manually via the "Yenile" button, not on
 * a timer.
 */
export interface BaselineViewerProps {
  workspaceId: string;
  artifactObjectId: string;
}

function parseQuerySpec(raw: unknown): QuerySpec | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = querySpecSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function BaselineViewer({ workspaceId, artifactObjectId }: BaselineViewerProps) {
  const objectQuery = useObjectQuery(workspaceId, artifactObjectId);
  const object = objectQuery.data?.object;

  const querySpec = parseQuerySpec(object?.fieldValues.querySpec);

  const liveQuery = useQuery({
    queryKey: ['baselineComparison', workspaceId, artifactObjectId, querySpec],
    queryFn: () => postObjectsQuery(workspaceId, querySpec as QuerySpec),
    enabled: querySpec !== undefined,
  });

  if (object === undefined) {
    return null;
  }

  if (querySpec === undefined) {
    return (
      <div data-testid="baseline-unavailable">Bu taban çizgisi için karşılaştırma yapılamıyor.</div>
    );
  }

  const liveData = liveQuery.data;
  const liveObjects = liveData !== undefined && 'objects' in liveData ? liveData.objects : [];
  const nextCursor =
    liveData !== undefined && 'objects' in liveData ? liveData.nextCursor : undefined;

  const capturedValue =
    typeof object.fieldValues.capturedValue === 'number' ? object.fieldValues.capturedValue : 0;
  const aggregateFn = object.fieldValues.aggregateFn as AggregateFn;
  const targetFieldKey =
    typeof object.fieldValues.targetFieldKey === 'string'
      ? object.fieldValues.targetFieldKey
      : undefined;

  const currentValue = computeQueryAggregate(
    liveObjects.map((row) => ({ title: row.title, fieldValues: row.fieldValues })),
    aggregateFn,
    targetFieldKey,
  );

  const deviation = computeDeviation({
    capturedValue,
    currentValue: currentValue ?? 0,
  });

  return (
    <div>
      <div data-testid="baseline-captured-value">{capturedValue}</div>
      <div data-testid="baseline-current-value">{currentValue}</div>
      <div data-testid="baseline-delta">{deviation.delta}</div>
      <div data-testid="baseline-percent-change">{deviation.percentChange}</div>

      <button
        type="button"
        data-testid="baseline-refresh-button"
        onClick={() => {
          void liveQuery.refetch();
        }}
      >
        Yenile
      </button>

      {nextCursor !== undefined ? (
        <div data-testid="baseline-more-rows-warning">
          Tüm eşleşen kayıtlar görüntülenmedi; sonuç kısmi olabilir.
        </div>
      ) : null}
    </div>
  );
}
