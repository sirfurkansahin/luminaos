import { useEffect, useRef, useState } from 'react';

import type { SavedView } from '@luminaos/core-objects';
import type { QuerySpec } from '@luminaos/shared';
import { Button, useTheme } from '@luminaos/ui';

import { useViewParam } from './hooks/useViewParam';
import { BoardView } from './views/BoardView';
import { CalendarView } from './views/CalendarView';
import { TaskDetailPanel } from './views/detail/TaskDetailPanel';
import { ListView } from './views/ListView';
import { SavedViewsList } from './views/SavedViewsList';
import { SaveViewButton } from './views/SaveViewButton';
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

// F1-T9 PR2: real ownership/admin computation needs the signed-in user's id
// and workspace role, neither of which is wired into apps/web yet (same
// F0-T5-pending limitation as DEV_WORKSPACE_ID above). Until then this
// conservatively hides every manage affordance — real enforcement is the
// server's 403 either way (F1-T9 plan), so this is a UI nicety gap, not a
// security one.
function canManageSavedView(): boolean {
  return false;
}

export function App() {
  const { theme, toggleTheme } = useTheme();
  const { view, setView } = useViewParam();

  const [activeSavedView, setActiveSavedView] = useState<SavedView | undefined>(undefined);

  // Tracks whether the *next* `view` change below is happening because the
  // user just clicked a saved view (which also calls `setView` itself, to
  // switch to that view's `viewType`) — if so, the effect must NOT clear
  // `activeSavedView` right after having just set it. Any other `view`
  // change (a manual ViewSwitcher tab click) clears it, so a stale saved
  // querySpec doesn't silently keep applying (F1-T9 plan).
  const selectingSavedViewRef = useRef(false);

  useEffect(() => {
    if (selectingSavedViewRef.current) {
      selectingSavedViewRef.current = false;
      return;
    }
    setActiveSavedView(undefined);
  }, [view]);

  const handleSelectSavedView = (savedView: SavedView): void => {
    selectingSavedViewRef.current = true;
    setActiveSavedView(savedView);
    setView(savedView.viewType);
  };

  // Returns `activeSavedView` itself only when it matches `viewType`, the
  // current `objectType`, AND the current `workspaceId` — otherwise
  // `undefined`, so every call site below can use a plain `??`/optional-chain
  // fallback instead of a non-null assertion. The `workspaceId` check is
  // defense-in-depth: harmless today since `DEV_WORKSPACE_ID` is a single
  // hardcoded constant, but it stops a stale cross-workspace `querySpec`/
  // `dateField` from silently applying once F0-T5's workspace-switcher lands
  // (security review finding, F1-T9 PR2).
  const matchingSavedView = (viewType: SavedView['viewType']): SavedView | undefined =>
    activeSavedView !== undefined &&
    activeSavedView.viewType === viewType &&
    activeSavedView.objectType === OBJECT_TYPE &&
    activeSavedView.workspaceId === DEV_WORKSPACE_ID
      ? activeSavedView
      : undefined;

  const listQuerySpec = matchingSavedView('list')?.querySpec ?? flatQuerySpec;
  const tableQuerySpec = matchingSavedView('table')?.querySpec ?? flatQuerySpec;
  const activeBoardQuerySpec = matchingSavedView('board')?.querySpec ?? boardQuerySpec;

  const initialDateField = matchingSavedView('calendar')?.dateField;
  const initialStartField = matchingSavedView('timeline')?.startField;
  const initialEndField = matchingSavedView('timeline')?.endField;

  // Mirrors CalendarView's/TimelineView's own resolved field selection
  // (seeded from initial*Field, defaulted to candidates[0]/[1], or changed
  // by the user via the in-view Select) so "save current view" captures
  // what's actually live instead of requiring the user to retype a field key.
  const [liveDateField, setLiveDateField] = useState<string | undefined>(undefined);
  const [liveStartField, setLiveStartField] = useState<string | undefined>(undefined);
  const [liveEndField, setLiveEndField] = useState<string | undefined>(undefined);

  return (
    <main>
      <h1>LuminaOS</h1>

      <Button data-testid="theme-toggle" variant="ghost" onClick={toggleTheme}>
        Toggle theme ({theme})
      </Button>

      <ViewSwitcher />
      <TaskDetailPanel workspaceId={DEV_WORKSPACE_ID} />
      <CreateObjectButton workspaceId={DEV_WORKSPACE_ID} objectType={OBJECT_TYPE} />
      <SavedViewsList
        workspaceId={DEV_WORKSPACE_ID}
        objectType={OBJECT_TYPE}
        onSelect={handleSelectSavedView}
        canManage={canManageSavedView}
      />
      {(view === 'list' || view === 'board' || view === 'table') && (
        <SaveViewButton
          workspaceId={DEV_WORKSPACE_ID}
          objectType={OBJECT_TYPE}
          viewType={view}
          querySpec={
            view === 'board'
              ? activeBoardQuerySpec
              : view === 'table'
                ? tableQuerySpec
                : listQuerySpec
          }
        />
      )}
      {view === 'calendar' && (
        <SaveViewButton
          workspaceId={DEV_WORKSPACE_ID}
          objectType={OBJECT_TYPE}
          viewType="calendar"
          {...(liveDateField !== undefined ? { dateField: liveDateField } : {})}
        />
      )}
      {view === 'timeline' && (
        <SaveViewButton
          workspaceId={DEV_WORKSPACE_ID}
          objectType={OBJECT_TYPE}
          viewType="timeline"
          {...(liveStartField !== undefined ? { startField: liveStartField } : {})}
          {...(liveEndField !== undefined ? { endField: liveEndField } : {})}
        />
      )}

      {view === 'list' && <ListView workspaceId={DEV_WORKSPACE_ID} querySpec={listQuerySpec} />}
      {view === 'table' && <TableView workspaceId={DEV_WORKSPACE_ID} querySpec={tableQuerySpec} />}
      {view === 'board' && (
        <BoardView workspaceId={DEV_WORKSPACE_ID} querySpec={activeBoardQuerySpec} />
      )}
      {view === 'calendar' && (
        <CalendarView
          workspaceId={DEV_WORKSPACE_ID}
          objectType={OBJECT_TYPE}
          {...(initialDateField !== undefined ? { initialDateField } : {})}
          onDateFieldChange={setLiveDateField}
        />
      )}
      {view === 'timeline' && (
        <TimelineView
          workspaceId={DEV_WORKSPACE_ID}
          objectType={OBJECT_TYPE}
          {...(initialStartField !== undefined ? { initialStartField } : {})}
          {...(initialEndField !== undefined ? { initialEndField } : {})}
          onStartFieldChange={setLiveStartField}
          onEndFieldChange={setLiveEndField}
        />
      )}
    </main>
  );
}
