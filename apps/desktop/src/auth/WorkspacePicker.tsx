import { setWorkspaceId } from '../workspace-context.js';

interface WorkspaceOption {
  id: string;
  name: string;
}

/**
 * Explicit workspace-selection screen for multi-workspace users (F2-T3b,
 * Open Question 1 Option B) -- shown by the login/session composition root
 * whenever `useSession().workspaces.length > 1`, since `SessionContext`
 * deliberately does NOT auto-select in that case (see
 * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL" item 7).
 *
 * `onSelect` is optional: `../workspace-context.js`'s `setWorkspaceId` is
 * always called (the real write path), and the caller (e.g. the desktop
 * composition root in `main.tsx`) can additionally observe the pick to
 * re-render past this screen -- `getWorkspaceId()`'s plain `localStorage`
 * read is not itself reactive.
 */
export function WorkspacePicker({
  workspaces,
  onSelect,
}: {
  workspaces: WorkspaceOption[];
  onSelect?: (id: string) => void;
}): React.JSX.Element {
  function handleSelect(id: string): void {
    setWorkspaceId(id);
    onSelect?.(id);
  }

  return (
    <section>
      <h1>Bir workspace seçin</h1>
      <ul>
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <button
              type="button"
              data-testid={`workspace-option-${workspace.id}`}
              onClick={() => {
                handleSelect(workspace.id);
              }}
            >
              {workspace.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
