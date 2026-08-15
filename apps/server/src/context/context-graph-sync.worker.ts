import { Injectable } from '@nestjs/common';

import { ContextGraphProjection } from './context-graph.projection.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * How often `syncOnce()` is invoked via the background interval. ADR-0018
 * Karar (a): deliberately 5 SECONDS, NOT `CalendarSyncPollerService`'s 5
 * MINUTES -- that worker is bound by a third-party API rate limit, this one
 * is a cheap in-process DB-to-DB `ProjectionRunner.catchUp` call.
 */
const SYNC_INTERVAL_MS = 5_000;

/**
 * `ContextGraphSyncWorker` -- ADR-0018 Karar (a): a
 * `CalendarSyncPollerService`-shaped periodic worker that drives
 * `ContextGraphProjection`'s catch-up (ADR-0017 Karar h had deliberately
 * left it unwired from any write path). `OnModuleInit`/`OnModuleDestroy`
 * start/stop a `setInterval`; the public `syncOnce()` lets callers (and
 * tests) trigger a catch-up directly without waiting on the real interval.
 *
 * Selecting Option C (scheduled background worker) over a query-time
 * synchronous `catchUp` was a deliberate ADR-0018 decision: `ProjectionRunner
 * .catchUp`'s advisory lock/checkpoint are keyed by PROJECTION NAME, not
 * workspace, so a query-time `catchUp` would serialize every workspace's
 * context queries behind one global lock (noisy-neighbor risk).
 */
@Injectable()
export class ContextGraphSyncWorker implements OnModuleInit, OnModuleDestroy {
  /**
   * A single, stable `ContextGraphProjection` instance for this worker's
   * lifetime -- mirrors `RelationsService.projection`'s/`ObjectsService.
   * projection`'s own "stable instance, checkpointed by name not identity"
   * reasoning.
   */
  private readonly projection = new ContextGraphProjection();

  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly projectionRunner: ProjectionRunner) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.syncOnce();
    }, SYNC_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async syncOnce(): Promise<void> {
    await this.projectionRunner.catchUp(this.projection);
  }
}
