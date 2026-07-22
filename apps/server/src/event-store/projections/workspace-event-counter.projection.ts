import { sql } from 'drizzle-orm';

import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { projectionWorkspaceEventCounts } from '../../db/schema/projection-workspace-event-counts.js';

import type { Database } from '../../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `EventStoreService`'s own `DbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries, so it
 * casts the opaque handle back — mirroring `EventStoreService`'s own
 * `DbTransaction` derivation pattern rather than inventing a third way.
 */
function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

/**
 * Example `Projection` (F0-T6 PR-B, AC4): maintains a running per-workspace
 * count of every event ever recorded, regardless of type (`handles = ['*']`)
 * — proves the projection framework's catch-up/rebuild determinism.
 */
export class WorkspaceEventCounterProjection implements Projection {
  readonly name = 'workspace-event-counter';
  readonly handles: readonly string[] = ['*'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx
      .insert(projectionWorkspaceEventCounts)
      .values({ workspaceId: event.workspaceId, eventCount: 1 })
      .onConflictDoUpdate({
        target: projectionWorkspaceEventCounts.workspaceId,
        set: { eventCount: sql`${projectionWorkspaceEventCounts.eventCount} + 1` },
      });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(projectionWorkspaceEventCounts);
  }
}
