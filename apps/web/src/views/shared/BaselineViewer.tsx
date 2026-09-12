import { useQuery } from '@tanstack/react-query';

import { computeDeviation, computeQueryAggregate } from '@luminaos/artifacts';
import type { AggregateFn } from '@luminaos/core-objects';
import { querySpecSchema } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';
import { Button, Card, EmptyState } from '@luminaos/ui';

import { useExplainDeviationMutation } from '../../hooks/useExplainDeviationMutation.js';
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

/**
 * F3-T11 PR3 (sapma açıklama kartı, ADR-0045 Karar f) -- mirrors this file's
 * own `parseQuerySpec`'s defensive JSON.parse + fallback discipline exactly:
 * malformed/non-JSON/non-string-array input never throws, it just yields no
 * causes.
 */
function parseExplanationCauses(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    return [];
  }

  return parsed;
}

export function BaselineViewer({ workspaceId, artifactObjectId }: BaselineViewerProps) {
  const objectQuery = useObjectQuery(workspaceId, artifactObjectId);
  const object = objectQuery.data?.object;

  const explainMutation = useExplainDeviationMutation(workspaceId, artifactObjectId);

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

  const explanationSummary =
    typeof object.fieldValues.explanationSummary === 'string' &&
    object.fieldValues.explanationSummary.length > 0
      ? object.fieldValues.explanationSummary
      : undefined;
  const explanationCauses = parseExplanationCauses(object.fieldValues.explanationCauses);

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

      <Button
        data-testid="baseline-explain-button"
        disabled={explainMutation.isPending}
        onClick={() => {
          explainMutation.mutate();
        }}
      >
        {explanationSummary !== undefined ? 'Yeniden oluştur' : 'Açıklama iste'}
      </Button>

      {explainMutation.isPending ? (
        <div data-testid="baseline-explain-loading">Açıklama oluşturuluyor…</div>
      ) : null}

      {explainMutation.isError ? (
        <EmptyState
          data-testid="baseline-explain-error"
          title="Açıklama oluşturulamadı"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      {explanationSummary !== undefined ? (
        <Card data-testid="baseline-explanation-card">
          <div data-testid="baseline-explanation-summary">{explanationSummary}</div>
          <ul>
            {explanationCauses.map((cause, index) => (
              <li key={index} data-testid="baseline-explanation-cause">
                {cause}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
