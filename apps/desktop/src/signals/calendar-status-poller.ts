import {
  captureDesktopSignal,
  getDesktopSignalConsent,
  listCalendarEvents,
} from '../api/http-client.js';
import { getWorkspaceId } from '../workspace-context.js';

const SIGNAL_TYPE = 'calendar-status';

/** Narrow window around "now" used to ask the server for events that might overlap it. */
const RANGE_PADDING_MS = 15 * 60 * 1000;

export interface CalendarStatusPoller {
  start: () => void;
  stop: () => void;
}

type BusyFreeStatus = 'busy' | 'free';

/**
 * Debounce-on-change poller deriving a coarse `'busy' | 'free'` desktop
 * signal from cached calendar events (F2-T3 PR4, ADR-0020 Karar c/e).
 *
 * **KRİTİK (ADR Karar e, yerinde işleme sınırı):** the value handed to
 * `captureDesktopSignal` is ALWAYS one of the two literal strings below —
 * `event.title`/any other event field NEVER leaves this function.
 */
export function createCalendarStatusPoller(intervalMs: number): CalendarStatusPoller {
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let lastSentValue: BusyFreeStatus | undefined;

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

    const now = Date.now();
    const range = {
      start: new Date(now - RANGE_PADDING_MS).toISOString(),
      end: new Date(now + RANGE_PADDING_MS).toISOString(),
    };
    const events = await listCalendarEvents(workspaceId, range);

    const status: BusyFreeStatus = events.some(
      (event) => new Date(event.start).getTime() <= now && now < new Date(event.end).getTime(),
    )
      ? 'busy'
      : 'free';

    if (status === lastSentValue) {
      return;
    }

    lastSentValue = status;
    await captureDesktopSignal(workspaceId, SIGNAL_TYPE, status);
  }

  function start(): void {
    intervalId = setInterval(() => {
      void tick();
    }, intervalMs);
  }

  return { start, stop };
}
