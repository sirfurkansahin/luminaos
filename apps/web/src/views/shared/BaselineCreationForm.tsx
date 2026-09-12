import { useState } from 'react';

import type { AggregateFn } from '@luminaos/core-objects';
import {
  Button,
  EmptyState,
  Input,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
} from '@luminaos/ui';

import { BaselineViewer } from './BaselineViewer.js';
import { useCaptureBaselineMutation } from '../../hooks/useCaptureBaselineMutation.js';
import { useSavedViewsQuery } from '../../hooks/useSavedViewsQuery.js';

/**
 * F3-T10 PR3 (evrensel baseline/sapma motoru, ADR-0044 Karar d/h, spec Kabul
 * Kriterleri) -- mirrors `WidgetGenerationForm.tsx`'s exact
 * structure/conventions. Per ADR-0044 Karar (d): the user does not write a
 * `QuerySpec` from scratch, they pick an existing `SavedView` and the form
 * derives the `QuerySpec` to submit as
 * `{...selectedSavedView.querySpec, objectType: selectedSavedView.objectType}`
 * -- deliberately overriding whatever `objectType` the saved view's own
 * `querySpec` might independently carry.
 */
export interface BaselineCreationFormProps {
  workspaceId: string;
}

const AGGREGATE_FN_OPTIONS: { value: AggregateFn; label: string }[] = [
  { value: 'sum', label: 'Toplam' },
  { value: 'avg', label: 'Ortalama' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maksimum' },
  { value: 'count', label: 'Sayım' },
  { value: 'countUnique', label: 'Benzersiz Sayım' },
  { value: 'countEmpty', label: 'Boş Sayım' },
];

// Mirrors `packages/artifacts/src/compute-query-aggregate.ts`'s own rule:
// every aggregateFn except 'count' requires a targetFieldKey.
const FIELD_REQUIRED_AGGREGATE_FNS: ReadonlySet<AggregateFn> = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'countUnique',
  'countEmpty',
]);

export function BaselineCreationForm({ workspaceId }: BaselineCreationFormProps) {
  const [title, setTitle] = useState('');
  const [objectType, setObjectType] = useState('');
  const [savedViewId, setSavedViewId] = useState<string | undefined>(undefined);
  const [aggregateFn, setAggregateFn] = useState<AggregateFn>('count');
  const [targetFieldKey, setTargetFieldKey] = useState('');

  const mutation = useCaptureBaselineMutation(workspaceId);
  const savedViewsQuery = useSavedViewsQuery(workspaceId, objectType);
  const savedViews = savedViewsQuery.data?.savedViews ?? [];
  const selectedSavedView = savedViews.find((savedView) => savedView.id === savedViewId);

  const trimmedTargetFieldKey = targetFieldKey.trim();
  const requiresTargetFieldKey = FIELD_REQUIRED_AGGREGATE_FNS.has(aggregateFn);

  const isSubmitDisabled =
    title.trim().length === 0 ||
    selectedSavedView === undefined ||
    (requiresTargetFieldKey && trimmedTargetFieldKey.length === 0) ||
    mutation.isPending;

  function handleSubmit(): void {
    if (isSubmitDisabled) {
      return;
    }

    const querySpec = {
      ...selectedSavedView.querySpec,
      objectType: selectedSavedView.objectType,
    };

    if (requiresTargetFieldKey) {
      mutation.mutate({
        title,
        querySpec,
        aggregateFn,
        targetFieldKey: trimmedTargetFieldKey,
      });
    } else {
      mutation.mutate({ title, querySpec, aggregateFn });
    }
  }

  return (
    <div>
      <Input
        data-testid="baseline-title-input"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        placeholder="Taban çizgisi adı"
      />

      <Input
        data-testid="baseline-object-type-input"
        value={objectType}
        onChange={(event) => {
          setObjectType(event.target.value);
        }}
        placeholder="Hedef obje tipi (ör. task)"
      />

      <SelectRoot
        onValueChange={(next) => {
          setSavedViewId(next);
        }}
      >
        <SelectTrigger data-testid="baseline-saved-view-select" aria-label="Kayıtlı görünüm">
          <SelectValue placeholder="Kayıtlı görünüm seç" />
        </SelectTrigger>
        <SelectContent>
          {savedViews.map((savedView) => (
            <SelectItem
              key={savedView.id}
              value={savedView.id}
              data-testid={`baseline-saved-view-option-${savedView.id}`}
            >
              {savedView.name}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>

      <SelectRoot
        value={aggregateFn}
        onValueChange={(next) => {
          setAggregateFn(next as AggregateFn);
        }}
      >
        <SelectTrigger
          data-testid="baseline-aggregate-fn-select"
          aria-label="Toplulaştırma fonksiyonu"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGGREGATE_FN_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={`baseline-aggregate-fn-option-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>

      <Input
        data-testid="baseline-target-field-key-input"
        value={targetFieldKey}
        onChange={(event) => {
          setTargetFieldKey(event.target.value);
        }}
        placeholder="Hedef alan anahtarı (opsiyonel)"
      />

      <Button
        data-testid="baseline-capture-submit"
        disabled={isSubmitDisabled}
        onClick={handleSubmit}
      >
        Yakala
      </Button>

      {mutation.isPending ? <div data-testid="baseline-capturing">Yakalanıyor…</div> : null}

      {mutation.isError ? (
        <EmptyState
          data-testid="baseline-capture-error"
          title="Taban çizgisi yakalanamadı"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      {mutation.isSuccess ? (
        <BaselineViewer workspaceId={workspaceId} artifactObjectId={mutation.data.object.id} />
      ) : null}
    </div>
  );
}
