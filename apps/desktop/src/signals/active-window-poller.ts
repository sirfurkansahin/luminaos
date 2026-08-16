import { captureDesktopSignal, getDesktopSignalConsent } from '../api/http-client.js';
import { getWorkspaceId } from '../workspace-context.js';
import { getActiveWindowAppName } from './active-window.js';

const SIGNAL_TYPE = 'active-window';

export interface ActiveWindowPoller {
  start: () => void;
  stop: () => void;
}

/**
 * Debounce-on-change poller for the "active window app name" desktop signal
 * (F2-T3 PR4, ADR-0020 Karar c). Plain closure/module-instance state, not
 * React state — this is an independently-testable unit, not a hook.
 */
export function createActiveWindowPoller(intervalMs: number): ActiveWindowPoller {
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let lastSentValue: string | undefined;

  function stop(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }

  async function tick(): Promise<void> {
    const workspaceId = getWorkspaceId();
    if (workspaceId === null) {
      return;
    }

    const consent = await getDesktopSignalConsent(workspaceId, SIGNAL_TYPE);
    if (consent === null || consent.revokedAt !== null) {
      stop();
      return;
    }

    const value = await getActiveWindowAppName();
    if (value === lastSentValue) {
      return;
    }

    lastSentValue = value;
    await captureDesktopSignal(workspaceId, SIGNAL_TYPE, value);
  }

  function start(): void {
    intervalId = setInterval(() => {
      void tick();
    }, intervalMs);
  }

  return { start, stop };
}
