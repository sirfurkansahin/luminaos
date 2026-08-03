import { createElement } from 'react';

import type { SavedView } from '@luminaos/core-objects';
import { EmptyState, Skeleton } from '@luminaos/ui';

import { useSavedViewsQuery } from '../hooks/useSavedViewsQuery.js';
import { resolveIcon } from './shared/IconPicker.js';

export interface SavedViewsListProps {
  workspaceId: string;
  objectType: string;
  onSelect: (savedView: SavedView) => void;
  // Presentational-only — the actual ownership/admin computation lives with
  // the caller (App.tsx / a future auth context), NOT in this component.
  // Real enforcement is the server's 403, per F1-T9 plan.
  canManage: (savedView: SavedView) => boolean;
  onManage?: (savedView: SavedView) => void;
}

export function SavedViewsList({
  workspaceId,
  objectType,
  onSelect,
  canManage,
  onManage,
}: SavedViewsListProps) {
  const { data, isLoading, isError } = useSavedViewsQuery(workspaceId, objectType);

  if (isLoading) {
    return (
      <div data-testid="saved-views-list-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="saved-views-list-error"
        title="Bir hata oluştu"
        description="Kaydedilmiş görünümler yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const savedViews = data?.savedViews ?? [];

  if (savedViews.length === 0) {
    return (
      <EmptyState
        data-testid="saved-views-list-empty"
        title="Kaydedilmiş görünüm yok"
        description="Henüz kaydedilmiş bir görünüm oluşturulmadı."
      />
    );
  }

  return (
    <ul aria-label="Kaydedilmiş görünümler">
      {savedViews.map((savedView) => (
        <li key={savedView.id}>
          <button
            type="button"
            data-testid={`saved-view-item-${savedView.id}`}
            onClick={() => {
              onSelect(savedView);
            }}
          >
            {createElement(resolveIcon(savedView.icon), { size: 16 })}
            <span>{savedView.name}</span>
          </button>
          {canManage(savedView) ? (
            <button
              type="button"
              data-testid={`saved-view-manage-button-${savedView.id}`}
              aria-label={`${savedView.name} görünümünü yönet`}
              onClick={() => {
                onManage?.(savedView);
              }}
            >
              ⋯
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
