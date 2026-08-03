import type { QuerySpec } from '@luminaos/shared';
import { Button, useTheme } from '@luminaos/ui';

import { useViewParam } from './hooks/useViewParam';
import { BoardView } from './views/BoardView';
import { CalendarView } from './views/CalendarView';
import { ListView } from './views/ListView';
import { CreateObjectButton } from './views/shared/CreateObjectButton';
import { TableView } from './views/TableView';
import { TimelineView } from './views/TimelineView';
import { ViewSwitcher } from './views/ViewSwitcher';

// Auth/workspace-switcher (F0-T5 hazır ama apps/web tarafında henüz
// tüketilmiyor) gelene kadar dev-only sabit bir workspace — F1-T7 PR1
// planındaki karar. `objectType` da aynı şekilde v0 için sabit.
const DEV_WORKSPACE_ID = 'dev-workspace';
const OBJECT_TYPE = 'task';

const flatQuerySpec: QuerySpec = { objectType: OBJECT_TYPE, filters: [] };
const boardQuerySpec: QuerySpec = { objectType: OBJECT_TYPE, filters: [], group: 'status' };

export function App() {
  const { theme, toggleTheme } = useTheme();
  const { view } = useViewParam();

  return (
    <main>
      <h1>LuminaOS</h1>

      <Button data-testid="theme-toggle" variant="ghost" onClick={toggleTheme}>
        Toggle theme ({theme})
      </Button>

      <ViewSwitcher />
      <CreateObjectButton workspaceId={DEV_WORKSPACE_ID} objectType={OBJECT_TYPE} />

      {view === 'list' && <ListView workspaceId={DEV_WORKSPACE_ID} querySpec={flatQuerySpec} />}
      {view === 'table' && <TableView workspaceId={DEV_WORKSPACE_ID} querySpec={flatQuerySpec} />}
      {view === 'board' && <BoardView workspaceId={DEV_WORKSPACE_ID} querySpec={boardQuerySpec} />}
      {view === 'calendar' && (
        <CalendarView workspaceId={DEV_WORKSPACE_ID} objectType={OBJECT_TYPE} />
      )}
      {view === 'timeline' && (
        <TimelineView workspaceId={DEV_WORKSPACE_ID} objectType={OBJECT_TYPE} />
      )}
    </main>
  );
}
