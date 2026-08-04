import { useMemo, useRef } from 'react';

import type { QuerySpec } from '@luminaos/shared';
import { EmptyState, Skeleton } from '@luminaos/ui';

import { useObjectIdParam } from '../hooks/useObjectIdParam.js';
import { useObjectsQuery, useSetFieldValuesMutation } from '../hooks/useObjectsQuery.js';
import { EditableCell } from './table/EditableCell.js';

import type { KeyboardEvent } from 'react';

export interface TableViewProps {
  workspaceId: string;
  querySpec: QuerySpec;
}

export function TableView({ workspaceId, querySpec }: TableViewProps) {
  const { data, isLoading, isError } = useObjectsQuery(workspaceId, querySpec);
  const { mutate } = useSetFieldValuesMutation(workspaceId);
  const { openObject } = useObjectIdParam();
  const objects = data !== undefined && 'objects' in data ? data.objects : [];
  const firstObject = objects[0];
  const columnKeys = useMemo(
    () => (firstObject !== undefined ? Object.keys(firstObject.fieldValues) : []),
    [firstObject],
  );
  const columnCount = columnKeys.length;
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);

  const focusCell = (index: number): void => {
    cellRefs.current[index]?.focus();
  };

  const handleCellKeyDown =
    (row: number, col: number) =>
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const index = row * columnCount + col;
      switch (event.key) {
        case 'ArrowRight':
          if (col + 1 < columnCount) {
            focusCell(index + 1);
          }
          break;
        case 'ArrowLeft':
          if (col - 1 >= 0) {
            focusCell(index - 1);
          }
          break;
        case 'ArrowDown':
          if (row + 1 < objects.length) {
            focusCell(index + columnCount);
          }
          break;
        case 'ArrowUp':
          if (row - 1 >= 0) {
            focusCell(index - columnCount);
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    };

  // See ListView.tsx's comment: `isLoading` alone misses the gap between
  // retry attempts (isFetching briefly false, isError not yet true).
  if (isLoading || (data === undefined && !isError)) {
    return (
      <div data-testid="table-view-loading">
        <Skeleton height={40} />
        <Skeleton height={40} />
        <Skeleton height={40} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="table-view-error"
        title="Bir hata oluştu"
        description="Nesneler yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  if (objects.length === 0) {
    return (
      <EmptyState
        data-testid="table-view-empty"
        title="Henüz nesne yok"
        description="İlk nesneni oluşturarak başla."
      />
    );
  }

  return (
    <div role="grid">
      {objects.map((object, row) => (
        <div key={object.id} role="row" data-testid="table-row">
          <span
            data-testid="table-title-cell"
            role="button"
            tabIndex={0}
            onClick={() => {
              openObject(object.id);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
              if (event.key === 'Enter') {
                openObject(object.id);
              }
            }}
          >
            {object.title}
          </span>
          {columnKeys.map((fieldKey, col) => {
            const index = row * columnCount + col;
            return (
              <div
                key={fieldKey}
                role="gridcell"
                data-testid="table-cell"
                tabIndex={0}
                ref={(element) => {
                  cellRefs.current[index] = element;
                }}
                onKeyDown={handleCellKeyDown(row, col)}
              >
                <EditableCell
                  value={object.fieldValues[fieldKey]}
                  onCommit={(newValue) => {
                    mutate({ objectId: object.id, values: { [fieldKey]: newValue } });
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
