import { useEffect, useRef, useState } from 'react';

import type { SavedView } from '@luminaos/core-objects';
import type { QuerySpec } from '@luminaos/shared';
import { Button, useTheme } from '@luminaos/ui';

import { ChangePasswordPanel } from './auth/ChangePasswordPanel';
import { SessionGate } from './auth/SessionGate';
import { useViewParam } from './hooks/useViewParam';
import { BoardView } from './views/BoardView';
import { CalendarView } from './views/CalendarView';
import { ObjectDetailHost } from './views/detail/ObjectDetailHost';
import { ListView } from './views/ListView';
import { SavedViewsList } from './views/SavedViewsList';
import { SaveViewButton } from './views/SaveViewButton';
import { AgentDirectoryPanel } from './views/shared/AgentDirectoryPanel';
import { AmbientProposalsBadge } from './views/shared/AmbientProposalsBadge';
import { AutomationHistoryPanel } from './views/shared/AutomationHistoryPanel';
import { AutonomyTierPanel } from './views/shared/AutonomyTierPanel';
import { AvailabilitySelector } from './views/shared/AvailabilitySelector';
import { CommandPalette } from './views/shared/CommandPalette';
import { CreateObjectButton } from './views/shared/CreateObjectButton';
import { DirectMessagePanel } from './views/shared/DirectMessagePanel';
import { FederationAuditLogPanel } from './views/shared/FederationAuditLogPanel';
import { FederationLinksPanel } from './views/shared/FederationLinksPanel';
import { FlightRecorderPanel } from './views/shared/FlightRecorderPanel';
import { IntegrationsPanel } from './views/shared/IntegrationsPanel';
import { McpAccessPanel } from './views/shared/McpAccessPanel';
import { MemoryPassportPanel } from './views/shared/MemoryPassportPanel';
import { NotificationPreferencesPanel } from './views/shared/NotificationPreferencesPanel';
import { TriggerSuggestionsPanel } from './views/shared/TriggerSuggestionsPanel';
import { WebhookSubscriptionsPanel } from './views/shared/WebhookSubscriptionsPanel';
import { TableView } from './views/TableView';
import { TimelineView } from './views/TimelineView';
import { ViewSwitcher } from './views/ViewSwitcher';

const OBJECT_TYPE = 'task';

const flatQuerySpec: QuerySpec = { objectType: OBJECT_TYPE, filters: [] };
const boardQuerySpec: QuerySpec = { objectType: OBJECT_TYPE, filters: [], group: 'status' };

// Personal-view ownership is not part of the list DTO yet. Keep management
// hidden until that ownership signal is available; shared/admin enforcement
// remains server-side.
function canManageSavedView(): boolean {
  return false;
}

interface WorkspaceAppProps {
  workspaceId: string;
  userId: string;
  userEmail: string;
  workspaceName: string;
  workspaces: { id: string; name: string }[];
  isAdmin: boolean;
  onWorkspaceChange: (workspaceId: string) => void;
  onLogout: () => void;
  isLoggingOut: boolean;
}

export function App() {
  return (
    <SessionGate>
      {(session) => (
        <WorkspaceApp
          key={session.workspaceId}
          workspaceId={session.workspaceId}
          userId={session.user.id}
          userEmail={session.user.email}
          workspaceName={session.workspaceName}
          workspaces={session.workspaces}
          isAdmin={session.role === 'owner' || session.role === 'admin'}
          onWorkspaceChange={session.onWorkspaceChange}
          onLogout={session.onLogout}
          isLoggingOut={session.isLoggingOut}
        />
      )}
    </SessionGate>
  );
}

export function WorkspaceApp({
  workspaceId,
  userId,
  userEmail,
  workspaceName,
  workspaces,
  isAdmin,
  onWorkspaceChange,
  onLogout,
  isLoggingOut,
}: WorkspaceAppProps) {
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
  // This stops a stale cross-workspace `querySpec`/
  // `dateField` from silently applying after a workspace switch (security
  // review finding, F1-T9 PR2).
  const matchingSavedView = (viewType: SavedView['viewType']): SavedView | undefined =>
    activeSavedView !== undefined &&
    activeSavedView.viewType === viewType &&
    activeSavedView.objectType === OBJECT_TYPE &&
    activeSavedView.workspaceId === workspaceId
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

  // F3-T14 PR3 (ADR-0048) -- dev-only: `FederationAuditLogPanel` needs a
  // specific `linkId` to view, but there is no link-selection UI yet
  // (`FederationLinksPanel`'s own list doesn't expose an onSelect callback,
  // mirroring its pinned test contract). A plain text input lets a developer
  // paste a `FederationLink`'s id (visible in `FederationLinksPanel`'s own
  // list/network tab) to exercise the audit-log panel manually.
  const [federationAuditLinkId, setFederationAuditLinkId] = useState('');

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>LuminaOS</h1>
          <span className="workspace-context">{workspaceName}</span>
        </div>
        <div className="session-controls">
          {workspaces.length > 1 && (
            <label className="workspace-picker">
              <span>Çalışma alanı</span>
              <select
                value={workspaceId}
                onChange={(event) => {
                  onWorkspaceChange(event.target.value);
                }}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="session-email">{userEmail}</span>
          <Button data-testid="theme-toggle" variant="ghost" onClick={toggleTheme}>
            Tema: {theme === 'light' ? 'Açık' : 'Koyu'}
          </Button>
          <Button variant="ghost" onClick={onLogout} disabled={isLoggingOut}>
            {isLoggingOut ? 'Çıkılıyor…' : 'Çıkış yap'}
          </Button>
        </div>
      </header>
      <CommandPalette workspaceId={workspaceId} />
      <details className="advanced-tools">
        <summary>Gelişmiş araçlar ve ayarlar</summary>
        <div className="advanced-tools__content">
          <ChangePasswordPanel />
          <MemoryPassportPanel workspaceId={workspaceId} />
          <IntegrationsPanel workspaceId={workspaceId} />
          <McpAccessPanel workspaceId={workspaceId} />
          <WebhookSubscriptionsPanel workspaceId={workspaceId} />
          <AmbientProposalsBadge workspaceId={workspaceId} />
          <div id="automation-history-panel">
            <AutomationHistoryPanel workspaceId={workspaceId} />
          </div>
          <TriggerSuggestionsPanel workspaceId={workspaceId} />
          <AgentDirectoryPanel workspaceId={workspaceId} />
          <DirectMessagePanel workspaceId={workspaceId} />
          <FlightRecorderPanel workspaceId={workspaceId} />
          <FederationLinksPanel workspaceId={workspaceId} isAdmin={isAdmin} />
          <input
            data-testid="federation-audit-log-link-id-input"
            value={federationAuditLinkId}
            onChange={(event) => {
              setFederationAuditLinkId(event.target.value);
            }}
            placeholder="Denetim günlüğü için FederationLink id'si"
          />
          {federationAuditLinkId.trim().length > 0 && (
            <FederationAuditLogPanel
              workspaceId={workspaceId}
              linkId={federationAuditLinkId.trim()}
            />
          )}
          <AutonomyTierPanel workspaceId={workspaceId} userId={userId} />
          <NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />
        </div>
      </details>

      <AvailabilitySelector workspaceId={workspaceId} />

      <div className="view-switcher-scroller">
        <ViewSwitcher />
      </div>
      <ObjectDetailHost workspaceId={workspaceId} />
      <div className="primary-actions">
        <CreateObjectButton workspaceId={workspaceId} objectType={OBJECT_TYPE} />
      </div>
      <SavedViewsList
        workspaceId={workspaceId}
        objectType={OBJECT_TYPE}
        onSelect={handleSelectSavedView}
        canManage={canManageSavedView}
      />
      {(view === 'list' || view === 'board' || view === 'table') && (
        <SaveViewButton
          workspaceId={workspaceId}
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
          workspaceId={workspaceId}
          objectType={OBJECT_TYPE}
          viewType="calendar"
          {...(liveDateField !== undefined ? { dateField: liveDateField } : {})}
        />
      )}
      {view === 'timeline' && (
        <SaveViewButton
          workspaceId={workspaceId}
          objectType={OBJECT_TYPE}
          viewType="timeline"
          {...(liveStartField !== undefined ? { startField: liveStartField } : {})}
          {...(liveEndField !== undefined ? { endField: liveEndField } : {})}
        />
      )}

      {view === 'list' && <ListView workspaceId={workspaceId} querySpec={listQuerySpec} />}
      {view === 'table' && <TableView workspaceId={workspaceId} querySpec={tableQuerySpec} />}
      {view === 'board' && <BoardView workspaceId={workspaceId} querySpec={activeBoardQuerySpec} />}
      {view === 'calendar' && (
        <CalendarView
          workspaceId={workspaceId}
          objectType={OBJECT_TYPE}
          {...(initialDateField !== undefined ? { initialDateField } : {})}
          onDateFieldChange={setLiveDateField}
        />
      )}
      {view === 'timeline' && (
        <TimelineView
          workspaceId={workspaceId}
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
