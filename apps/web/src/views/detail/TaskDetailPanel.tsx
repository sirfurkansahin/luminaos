import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogClose,
  EmptyState,
  Skeleton,
} from '@luminaos/ui';

import { ChecklistWidget } from './ChecklistWidget.js';
import { RecurrenceRulePicker } from './RecurrenceRulePicker.js';
import { ReminderPicker } from './ReminderPicker.js';
import { StatusPrioritySelect } from './StatusPrioritySelect.js';
import { useFieldDefinitionsQuery } from '../../hooks/useFieldDefinitionsQuery.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { useObjectQuery } from '../../hooks/useObjectsQuery.js';

export interface TaskDetailPanelProps {
  workspaceId: string;
}

export function TaskDetailPanel({ workspaceId }: TaskDetailPanelProps) {
  const { objectId, closeObject } = useObjectIdParam();
  const { data, isLoading, isError } = useObjectQuery(workspaceId, objectId);

  const fieldDefinitionsQuery = useFieldDefinitionsQuery(
    workspaceId,
    data !== undefined ? data.object.type : undefined,
  );
  const fieldDefinitions = fieldDefinitionsQuery.data?.fieldDefinitions;

  const statusFieldDefinition = fieldDefinitions?.find((definition) => definition.key === 'status');
  const priorityFieldDefinition = fieldDefinitions?.find(
    (definition) => definition.key === 'priority',
  );

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
          <>
            <DialogTitle>{data.object.title}</DialogTitle>
            <ChecklistWidget
              workspaceId={workspaceId}
              objectId={data.object.id}
              items={data.object.checklist}
            />
            <RecurrenceRulePicker
              workspaceId={workspaceId}
              objectId={data.object.id}
              currentRule={data.object.recurrenceRule}
            />
            <ReminderPicker
              workspaceId={workspaceId}
              objectId={data.object.id}
              remindAt={data.object.fieldValues.remindAt}
              remindAcknowledged={data.object.fieldValues.remindAcknowledged}
            />
            {statusFieldDefinition !== undefined ? (
              <StatusPrioritySelect
                workspaceId={workspaceId}
                objectId={data.object.id}
                fieldKey="status"
                fieldDefinition={statusFieldDefinition}
                currentValue={data.object.fieldValues.status}
              />
            ) : null}
            {priorityFieldDefinition !== undefined ? (
              <StatusPrioritySelect
                workspaceId={workspaceId}
                objectId={data.object.id}
                fieldKey="priority"
                fieldDefinition={priorityFieldDefinition}
                currentValue={data.object.fieldValues.priority}
              />
            ) : null}
          </>
        ) : null}
        <DialogClose data-testid="task-detail-panel-close">Kapat</DialogClose>
      </DialogContent>
    </DialogRoot>
  );
}
