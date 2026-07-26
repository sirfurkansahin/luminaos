import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

import type { QuerySpec } from '@luminaos/shared';
import { EmptyState, Skeleton } from '@luminaos/ui';

import { useObjectsQuery } from '../hooks/useObjectsQuery.js';

export interface ListViewProps {
  workspaceId: string;
  querySpec: QuerySpec;
}

export function ListView({ workspaceId, querySpec }: ListViewProps) {
  const { data, isLoading, isError } = useObjectsQuery(workspaceId, querySpec);
  const parentRef = useRef<HTMLDivElement>(null);
  const objects = data !== undefined && 'objects' in data ? data.objects : [];

  const virtualizer = useVirtualizer({
    count: objects.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
    // jsdom (used in tests) never lays out `offsetWidth`/`offsetHeight`
    // (always 0), which is what the library's default `observeElementRect`
    // measures with — so the virtualizer would always see a 0-sized
    // container. `getBoundingClientRect()` works in both real browsers and
    // jsdom-mocked test environments, so it's used here instead.
    observeElementRect: (instance, cb) => {
      const element = instance.scrollElement;
      if (element === null) {
        return;
      }
      const measure = (): void => {
        const rect = element.getBoundingClientRect();
        cb({ width: rect.width, height: rect.height });
      };
      measure();
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => {
        observer.unobserve(element);
      };
    },
  });

  if (isLoading) {
    return (
      <div data-testid="list-view-loading">
        <Skeleton height={48} />
        <Skeleton height={48} />
        <Skeleton height={48} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="list-view-error"
        title="Bir hata oluştu"
        description="Nesneler yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  if (objects.length === 0) {
    return (
      <EmptyState
        data-testid="list-view-empty"
        title="Henüz nesne yok"
        description="İlk nesneni oluşturarak başla."
      />
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualItems.map((virtualRow) => {
          const object = objects[virtualRow.index];
          if (object === undefined) {
            return null;
          }
          return (
            <div
              key={object.id}
              data-testid="object-row"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start.toString()}px)`,
              }}
            >
              <span>{object.title}</span>
              {Object.entries(object.fieldValues)
                .slice(0, 3)
                .map(([key, value]) => (
                  <span key={key}> {String(value)}</span>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
