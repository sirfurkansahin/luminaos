import { invoke } from '@tauri-apps/api/core';

/**
 * Thin IPC wrapper over the `get_active_window_app_name` Tauri command
 * (ADR-0020 Karar e/f). Resolves with the foreground window's
 * process/application name (e.g. `Code.exe`) — never the full window
 * title text.
 *
 * No debounce/change-detection/HTTP logic here — that belongs to the
 * frontend-integration layer built on top of this helper (ADR-0020
 * Karar c, PR4 scope).
 */
export async function getActiveWindowAppName(): Promise<string> {
  return invoke('get_active_window_app_name');
}
