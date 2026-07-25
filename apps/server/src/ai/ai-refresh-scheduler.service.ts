import { Injectable, Logger } from '@nestjs/common';

/** `AIRefreshScheduler`'s own pure default delay (ms) — mirrors `env.ts`'s `aiRefreshDebounceMs` default so both behave identically when the env var is unset. */
const DEFAULT_DELAY_MS = 5000;

/**
 * A pure, framework-adjacent (NestJS `Logger` only — no DB/HTTP) in-process
 * debounce scheduler for the `onSourceChange` AI-field refresh trigger
 * (F1-T5 PR-C, per the approved plan, "kaynak alan değişince yenileme işi
 * kuyruklanır (in-process job, debounce 5 sn)").
 *
 * `schedule(objectId, fieldKey, refreshFn)` debounces per `(objectId,
 * fieldKey)` pair: calling it again for the SAME pair before the timer fires
 * cancels the previous timer and restarts the full delay window. Different
 * pairs get fully independent timers.
 *
 * A `refreshFn` that throws synchronously, or whose returned promise
 * rejects, is caught here and never propagates out of the internal timer
 * callback, nor does it affect any other pending/future timer — mirrors
 * `../event-store/event-bus.ts`'s `InProcessEventBus.logRejection` pattern:
 * a single, deliberately STATIC (non-interpolated) log message, never the
 * raw error content or any prompt/user data (CLAUDE.md: "Kullanıcı verisini
 * ... log'a yazma").
 */
@Injectable()
export class AIRefreshScheduler {
  private readonly logger = new Logger(AIRefreshScheduler.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly delayMs: number = DEFAULT_DELAY_MS) {}

  schedule(objectId: string, fieldKey: string, refreshFn: () => void | Promise<void>): void {
    const key = `${objectId}:${fieldKey}`;

    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.runSafely(refreshFn);
    }, this.delayMs);

    this.timers.set(key, timer);
  }

  private runSafely(refreshFn: () => void | Promise<void>): void {
    try {
      const result = refreshFn();
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.logFailure(error);
        });
      }
    } catch (error) {
      this.logFailure(error);
    }
  }

  private logFailure(error: unknown): void {
    this.logger.error(
      'Scheduled AI field refresh failed.',
      error instanceof Error ? error.stack : undefined,
    );
  }
}
