import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { Projection, ProjectionTx } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../../db/database-connection.token.js';
import { projectionCheckpoints } from '../../db/schema/projection-checkpoints.js';
import { EventStoreService } from '../event-store.service.js';

import type { Database } from '../../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `EventStoreService`'s own `DbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** How many events `catchUp` reads per page while replaying the log. */
const BATCH_SIZE = 500;

/**
 * Drives a `Projection`'s catch-up (incremental) and rebuild (full replay)
 * lifecycles against the event log. Per F0-T6's plan
 * (`giggly-brewing-moore.md`): `apply` + checkpoint advancement happen in the
 * SAME transaction (crash-safe, effectively-once); `rebuild` truncates the
 * projection's own state, resets its checkpoint to `0`, then replays the
 * entire log from the start via the same catch-up loop.
 */
@Injectable()
export class ProjectionRunner {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
  ) {}

  /**
   * Reads the log in `globalPosition` order, starting just after the
   * projection's last recorded checkpoint, applying every event whose type
   * this projection `handles` (or all events, for a `['*']` projection), and
   * advancing the checkpoint to the last-read position — all per batch, in
   * one transaction. Resumable: calling this again only processes events
   * appended since the previous call.
   */
  async catchUp(projection: Projection): Promise<void> {
    let checkpoint = await this.readCheckpoint(projection.name);

    for (;;) {
      const batch = await this.eventStore.readAllFrom(checkpoint, BATCH_SIZE);

      if (batch.length === 0) {
        return;
      }

      const lastPositionInBatch = batch[batch.length - 1]?.globalPosition;
      if (lastPositionInBatch === undefined) {
        return;
      }

      await this.db.transaction(async (tx) => {
        for (const event of batch) {
          if (projection.handles.includes('*') || projection.handles.includes(event.type)) {
            // `ProjectionTx` is intentionally opaque at the `packages/shared`
            // level (framework-free); the runner is the one place that
            // knows this handle is really the concrete Drizzle transaction
            // it just opened, so the cast is contained here.
            await projection.apply(event, tx as unknown as ProjectionTx);
          }
        }

        await this.writeCheckpoint(tx, projection.name, lastPositionInBatch);
      });

      checkpoint = lastPositionInBatch;

      if (batch.length < BATCH_SIZE) {
        return;
      }
    }
  }

  /**
   * Truncates the projection's own state and resets its checkpoint to `0`
   * (in one transaction), then replays the entire log from the beginning via
   * `catchUp`. Used to prove/repair determinism (F0-T6 AC4): a rebuilt
   * projection must reproduce exactly what incremental catch-up produced.
   */
  async rebuild(projection: Projection): Promise<void> {
    await this.db.transaction(async (tx) => {
      await projection.reset(tx as unknown as ProjectionTx);
      await this.writeCheckpoint(tx, projection.name, 0);
    });

    await this.catchUp(projection);
  }

  private async readCheckpoint(projectionName: string): Promise<number> {
    const [row] = await this.db
      .select({ lastPosition: projectionCheckpoints.lastPosition })
      .from(projectionCheckpoints)
      .where(eq(projectionCheckpoints.projectionName, projectionName));

    return row?.lastPosition ?? 0;
  }

  private async writeCheckpoint(
    tx: DbTransaction,
    projectionName: string,
    lastPosition: number,
  ): Promise<void> {
    await tx
      .insert(projectionCheckpoints)
      .values({ projectionName, lastPosition, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: projectionCheckpoints.projectionName,
        set: { lastPosition, updatedAt: new Date() },
      });
  }
}
