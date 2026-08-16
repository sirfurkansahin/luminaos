const WORKSPACE_ID_STORAGE_KEY = 'luminaos.workspaceId';

/**
 * Thin, synchronous read of the single `localStorage` key that stands in
 * for a real workspace-selection UI (F2-T3 PR4, ADR-0020). No caching, no
 * validation, no default value — a real login/workspace-selection flow is
 * deferred to F2-T3b (see `apps/desktop/README.md`'s manual smoke-test
 * steps for how this key gets populated in a dev webview today).
 */
export function getWorkspaceId(): string | null {
  return localStorage.getItem(WORKSPACE_ID_STORAGE_KEY);
}
