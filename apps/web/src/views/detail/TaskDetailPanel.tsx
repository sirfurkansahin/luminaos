import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogClose,
  EmptyState,
  Skeleton,
} from '@luminaos/ui';

import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { useObjectQuery } from '../../hooks/useObjectsQuery.js';

export interface TaskDetailPanelProps {
  workspaceId: string;
}

export function TaskDetailPanel({ workspaceId }: TaskDetailPanelProps) {
  const { objectId, closeObject } = useObjectIdParam();
  const { data, isLoading, isError } = useObjectQuery(workspaceId, objectId);

  return (
    <DialogRoot
      open={objectId !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          closeObject();
        }
      }}
    >
      <DialogContent>
        {isLoading ? (
          <div data-testid="task-detail-panel-loading">
            <DialogTitle>Yükleniyor…</DialogTitle>
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        ) : isError ? (
          <EmptyState
            data-testid="task-detail-panel-not-found"
            title="Nesne bulunamadı"
            description="Bu nesne silinmiş veya erişiminiz olmayabilir."
          />
        ) : data !== undefined ? (
          <DialogTitle>{data.object.title}</DialogTitle>
        ) : null}
        <DialogClose data-testid="task-detail-panel-close">Kapat</DialogClose>
      </DialogContent>
    </DialogRoot>
  );
}
