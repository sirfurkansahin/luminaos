import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';

import { WebhookDeliveryService } from './webhook-delivery.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { webhookDeliveries } from '../db/schema/webhook-deliveries.js';
import { webhookSubscriptions } from '../db/schema/webhook-subscriptions.js';

import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * How often `runOnce()` is invoked via the background interval (ADR-0033
 * §d's "~15-30 saniye" guidance) -- mirrors `TriggerSchedulerService`'s own
 * `SCHEDULER_INTERVAL_MS` naming/shape.
 */
const WORKER_INTERVAL_MS = 20_000;

/** A delivery is retried at most this many times before being marked terminal (`status: 'failed'`). */
const MAX_ATTEMPTS = 3;

/** Base exponential-backoff unit: `30_000 * 2 ** (attempts - 1)` ms. */
const BACKOFF_BASE_MS = 30_000;

/**
 * Security-review finding (F2-T16 PR2): a claim "lease" duration used by
 * `claimRow()` -- long enough that it always exceeds `deliver()`'s own
 * `DELIVERY_TIMEOUT_MS` (10s) plus scheduling jitter, so a slow tick's
 * in-flight row is never re-claimed by the NEXT tick while still being
 * delivered. If the worker crashes mid-delivery, the row self-heals back to
 * claimable once this lease expires -- no separate "processing" status or
 * cleanup job needed.
 */
const CLAIM_LEASE_MS = 60_000;

interface DueDeliveryRow {
  id: string;
  subscriptionId: string;
  payload: unknown;
  attempts: number;
  targetUrl: string;
  encryptedSigningSecret: string;
  nextAttemptAt: Date;
}

/**
 * `WebhookDeliveryWorker` (F2-T16 PR2, ADR-0033 §d): the background poller
 * that scans `webhook_deliveries` for `pending AND next_attempt_at <= now()`
 * rows and drives them through `WebhookDeliveryService.deliver()`. Mirrors
 * `TriggerSchedulerService`'s exact shape (`OnModuleInit`/`OnModuleDestroy`
 * with `setInterval`/`clearInterval`, a public `runOnce()` directly callable
 * by tests, per-row `try/catch` so one row's failure never aborts the rest
 * of the scan).
 */
@Injectable()
export class WebhookDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, WORKER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async runOnce(): Promise<void> {
    const now = new Date();

    const rows: DueDeliveryRow[] = await this.db
      .select({
        id: webhookDeliveries.id,
        subscriptionId: webhookDeliveries.subscriptionId,
        payload: webhookDeliveries.payload,
        attempts: webhookDeliveries.attempts,
        targetUrl: webhookSubscriptions.targetUrl,
        encryptedSigningSecret: webhookSubscriptions.encryptedSigningSecret,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id),
      )
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lte(webhookDeliveries.nextAttemptAt, now),
          // Security-review finding (F2-T16 PR2): a subscription soft-deleted
          // (`lifecycle: 'deleted'`, `webhook-subscriptions.service.ts`'s
          // `remove()`) AFTER a delivery row was already enqueued must never
          // keep receiving attempts -- the FK row/secret still physically
          // exist (soft delete), so without this filter the join alone would
          // happily keep POSTing to a target the user believed disabled.
          eq(webhookSubscriptions.lifecycle, 'active'),
        ),
      );

    for (const row of rows) {
      try {
        const claimed = await this.claimRow(row.id, row.nextAttemptAt);
        if (!claimed) {
          // Another (overlapping) tick already claimed this row -- skip it
          // rather than deliver a second time.
          continue;
        }

        const result = await this.webhookDeliveryService.deliver({
          targetUrl: row.targetUrl,
          encryptedSigningSecret: row.encryptedSigningSecret,
          payload: row.payload,
        });

        if (result.outcome === 'delivered') {
          await this.db
            .update(webhookDeliveries)
            .set({ status: 'delivered', deliveredAt: new Date() })
            .where(eq(webhookDeliveries.id, row.id));
          continue;
        }

        const newAttempts = row.attempts + 1;

        if (newAttempts < MAX_ATTEMPTS) {
          const backoffMs = BACKOFF_BASE_MS * 2 ** (newAttempts - 1);
          await this.db
            .update(webhookDeliveries)
            .set({
              status: 'pending',
              attempts: newAttempts,
              nextAttemptAt: new Date(Date.now() + backoffMs),
              lastError: result.sanitizedError,
            })
            .where(eq(webhookDeliveries.id, row.id));
        } else {
          await this.db
            .update(webhookDeliveries)
            .set({
              status: 'failed',
              attempts: newAttempts,
              lastError: result.sanitizedError,
            })
            .where(eq(webhookDeliveries.id, row.id));
        }
      } catch (error) {
        // One delivery's failure must never abort the rest of the scan --
        // mirrors `TriggerSchedulerService.runOnce()`'s identical per-row
        // isolation discipline. Logged with the opaque delivery id only,
        // never the delivery's own payload/target content (CLAUDE.md's
        // "kullanıcı verisini log'a yazma" rule).
        this.logger.error(
          `Webhook delivery failed for webhook_deliveries row ${row.id}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Security-review finding (F2-T16 PR2): an atomic conditional claim --
   * pushes `nextAttemptAt` forward by `CLAIM_LEASE_MS` ONLY if the row is
   * STILL `pending` with the SAME `nextAttemptAt` this tick originally read
   * (`observedNextAttemptAt`), using `.returning()` to detect whether the
   * UPDATE actually matched a row. If a concurrent/overlapping `runOnce()`
   * already claimed (or delivered) this row first, this UPDATE matches zero
   * rows and `claimRow` returns `false` -- the caller skips it rather than
   * deliver a second time. Guarding on the observed `nextAttemptAt` (not just
   * `status: 'pending'`) prevents this claim from re-claiming a row a
   * DIFFERENT tick already re-claimed a moment ago.
   */
  private async claimRow(rowId: string, observedNextAttemptAt: Date): Promise<boolean> {
    const claimedRows = await this.db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) })
      .where(
        and(
          eq(webhookDeliveries.id, rowId),
          eq(webhookDeliveries.status, 'pending'),
          eq(webhookDeliveries.nextAttemptAt, observedNextAttemptAt),
        ),
      )
      .returning({ id: webhookDeliveries.id });

    return claimedRows.length > 0;
  }
}
