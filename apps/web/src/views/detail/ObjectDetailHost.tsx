import { TaskDetailPanel } from './TaskDetailPanel.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { useObjectQuery } from '../../hooks/useObjectsQuery.js';
import { DocEditorPanel } from '../doc/DocEditorPanel.js';

export interface ObjectDetailHostProps {
  workspaceId: string;
}

export function ObjectDetailHost({ workspaceId }: ObjectDetailHostProps) {
  const { objectId, closeObject } = useObjectIdParam();
  const { data } = useObjectQuery(workspaceId, objectId);

  if (objectId !== undefined && data?.object.type === 'doc') {
    return <DocEditorPanel docId={objectId} title={data.object.title} onClose={closeObject} />;
  }

  return <TaskDetailPanel workspaceId={workspaceId} />;
}
