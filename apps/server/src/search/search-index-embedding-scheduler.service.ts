import { Injectable, Logger } from '@nestjs/common';

import type { OnModuleDestroy } from '@nestjs/common';

/** `SearchIndexEmbeddingScheduler`'s own pure default delay (ms) — mirrors `env.ts`'s `searchIndexEmbeddingDebounceMs` default so both behave identically when the env var is unset. */
const DEFAULT_DELAY_MS = 5000;

/**
 * A pure, framework-adjacent (NestJS `Logger` only — no DB/HTTP) in-process
 * debounce scheduler for recomputing `search_index.embedding` after a
 * title/doc-content change (ADR-0013 §(e)).
 *
 * Structural twin of `../ai/ai-refresh-scheduler.service.ts`'s
 * `AIRefreshScheduler` — same `Map<string, NodeJS.Timeout>`-keyed debounce,
 * same `runSafely`/`logFailure` swallow-and-log discipline for a
 * throwing/rejecting `refreshFn`, same STATIC (non-interpolated) log message
 * + `error.stack` only, never content/user data (CLAUDE.md: "Kullanıcı
 * verisini ... log'a yazma"). Unlike `AIRefreshScheduler.schedule(objectId,
 * fieldKey, refreshFn)` (keyed per-field), `schedule(objectId, refreshFn)`
 * is keyed by `objectId` ALONE — there is exactly ONE search-embedding
 * concept per object, not per-field.
 */
@Injectable()
export class SearchIndexEmbeddingScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(SearchIndexEmbeddingScheduler.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly delayMs: number = DEFAULT_DELAY_MS) {}

  schedule(objectId: string, refreshFn: () => void | Promise<void>): void {
    const existingTimer = this.timers.get(objectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.timers.delete(objectId);
      this.runSafely(refreshFn);
    }, this.delayMs);

    this.timers.set(objectId, timer);
  }

  /**
   * Clears every pending debounce timer on shutdown. Unlike `AIRefreshScheduler`
   * (only reached from a narrow, opt-in AI-field-refresh path), this scheduler
   * is invoked from EVERY mutating `ObjectsService` write path plus
   * `DocCollabGateway`'s WebSocket-driven snapshot path — a live timer at
   * shutdown is routine here, not an edge case, so explicit cleanup (mirroring
   * `DocCollabGateway.onModuleDestroy`'s own timer-clearing discipline) avoids
   * a scheduled refresh firing against a closing DB pool during teardown.
   */
  onModuleDestroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
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
      'Scheduled search index embedding refresh failed.',
      error instanceof Error ? error.stack : undefined,
    );
  }
}
