const WORKSPACE_ID_STORAGE_KEY = 'luminaos.workspaceId';

/**
 * Thin, synchronous read of the single `localStorage` key that stands in
 * for a real workspace-selection UI (F2-T3 PR4, ADR-0020). No caching, no
 * validation, no default value.
 */
export function getWorkspaceId(): string | null {
  return localStorage.getItem(WORKSPACE_ID_STORAGE_KEY);
}

/**
 * Thin, synchronous write of the same `localStorage` key (F2-T3b) — the
 * real write path used by `SessionContext`'s single-workspace
 * auto-selection and `WorkspacePicker`'s explicit selection, replacing the
 * manual dev-only `localStorage.setItem(...)` step documented previously in
 * `apps/desktop/README.md`. No validation beyond that: the caller is
 * responsible for passing a real workspace id.
 */
export function setWorkspaceId(id: string): void {
  localStorage.setItem(WORKSPACE_ID_STORAGE_KEY, id);
}
