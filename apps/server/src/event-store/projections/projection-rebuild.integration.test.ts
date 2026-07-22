import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NewDomainEvent } from '@luminaos/shared';

import { ProjectionRunner } from './projection-runner.service.js';
import { WorkspaceEventCounterProjection } from './workspace-event-counter.projection.js';
import { createDatabaseClient } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { projectionCheckpoints } from '../../db/schema/projection-checkpoints.js';
import { projectionWorkspaceEventCounts } from '../../db/schema/projection-workspace-event-counts.js';
import { workspaces } from '../../db/schema/workspaces.js';
import { EventStoreService } from '../event-store.service.js';

import type { Database } from '../../db/client.js';

/**
 * Real integration test (Testcontainers, real Postgres 16, no mocking) proving
 * F0-T6 PR-B's AC4: "Örnek projeksiyon rebuild ile sıfırdan aynı sonucu üretir"
 * — the example `workspace-event-counter` projection, after a full `rebuild()`
 * (truncate own state + reset checkpoint to 0 + replay the entire log from
 * position 0), produces IDENTICAL per-workspace counts and an identical
 * checkpoint position to what the original incremental catch-up produced.
 *
 * Mirrors `event-store.integration.test.ts`'s Testcontainers/`runMigrations`/
 * `createDatabaseClient`/`createWorkspace`/`buildNewEvent` conventions.
 *
 * ---
 *
 * GAP FLAGGED FOR `implementer` (do not silently paper over this while
 * implementing): as of PR-A, `EventStoreService` only exposes
 * `readByWorkspace(workspaceId, fromPosition)` — every read requires a
 * specific, already-known `workspaceId`. `ProjectionRunner`, per the plan,
 * needs to catch up / rebuild a projection by replaying the **entire** event
 * log in global-position order, regardless of workspace (the example
 * projection's `handles = ['*']` is deliberately workspace-agnostic, and a
 * future context-fabric-style projection will need the same). There is
 * currently no cross-workspace, position-ordered read on `EventStoreService`
 * to support this.
 *
 * This test assumes `ProjectionRunner` is constructed with the `Database`
 * client and the `EventStoreService` instance, and that `implementer` will
 * add a method resembling `EventStoreService.readAllFrom(fromPosition):
 * Promise<StoredEvent[]>` (workspace-agnostic, ordered by `globalPosition`,
 * exclusive cursor like `readByWorkspace`) for `ProjectionRunner` to page
 * through internally. This test does not call such a method directly (that
 * would be inventing implementation, not testing behavior) — it only
 * exercises `ProjectionRunner`'s public `catchUp`/`rebuild` outcomes, which
 * depend on that gap being closed first.
 */

function buildNewEvent(
  overrides: Partial<NewDomainEvent> & { workspaceId: string },
): NewDomainEvent {
  return {
    id: crypto.randomUUID(),
    streamType: 'test-stream',
    type: 'TestEventOccurred',
    payload: { foo: 'bar' },
    actor: { type: 'system', id: 'projection-rebuild-test' },
    occurredAt: new Date(),
    ...overrides,
  } satisfies NewDomainEvent;
}

describe('Projection rebuild determinism (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let projection: WorkspaceEventCounterProjection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);
    projection = new WorkspaceEventCounterProjection();
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: crypto.randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  async function getEventCounts(): Promise<Record<string, number>> {
    const rows = await db
      .select({
        workspaceId: projectionWorkspaceEventCounts.workspaceId,
        eventCount: projectionWorkspaceEventCounts.eventCount,
      })
      .from(projectionWorkspaceEventCounts);

    return Object.fromEntries(rows.map((row) => [row.workspaceId, row.eventCount]));
  }

  async function getCheckpoint(projectionName: string): Promise<number | undefined> {
    const [row] = await db
      .select({ lastPosition: projectionCheckpoints.lastPosition })
      .from(projectionCheckpoints)
      .where(eq(projectionCheckpoints.projectionName, projectionName));

    return row?.lastPosition;
  }

  describe('AC4: rebuild produces identical results to the original catch-up', () => {
    let workspaceA: string;
    let workspaceB: string;
    let checkpointAfterFirstCatchUp: number | undefined;
    let countsSnapshot: Record<string, number>;

    it('catch-up processes events from two workspaces and produces the correct per-workspace counts', async () => {
      workspaceA = await createWorkspace('rebuild-determinism-a');
      workspaceB = await createWorkspace('rebuild-determinism-b');

      const streamA = crypto.randomUUID();
      const streamB = crypto.randomUUID();

      // 5 events total across two workspaces/streams: 3 for A, 2 for B.
      await eventStore.append(streamA, 0, [buildNewEvent({ workspaceId: workspaceA, type: 'A1' })]);
      await eventStore.append(streamA, 1, [buildNewEvent({ workspaceId: workspaceA, type: 'A2' })]);
      await eventStore.append(streamA, 2, [buildNewEvent({ workspaceId: workspaceA, type: 'A3' })]);
      await eventStore.append(streamB, 0, [buildNewEvent({ workspaceId: workspaceB, type: 'B1' })]);
      await eventStore.append(streamB, 1, [buildNewEvent({ workspaceId: workspaceB, type: 'B2' })]);

      await projectionRunner.catchUp(projection);

      const counts = await getEventCounts();
      expect(counts[workspaceA]).toBe(3);
      expect(counts[workspaceB]).toBe(2);

      checkpointAfterFirstCatchUp = await getCheckpoint(projection.name);
      expect(checkpointAfterFirstCatchUp).toBeDefined();
      expect(checkpointAfterFirstCatchUp).toBeGreaterThan(0);

      countsSnapshot = { ...counts };
    });

    it('rebuild (truncate + checkpoint reset to 0 + full replay) reproduces the exact same per-workspace counts', async () => {
      await projectionRunner.rebuild(projection);

      const countsAfterRebuild = await getEventCounts();
      expect(countsAfterRebuild).toEqual(countsSnapshot);
    });

    it('rebuild reproduces the exact same checkpoint position as the original catch-up', async () => {
      const checkpointAfterRebuild = await getCheckpoint(projection.name);
      expect(checkpointAfterRebuild).toBe(checkpointAfterFirstCatchUp);
    });

    it('incremental catch-up (not rebuild) after a rebuild correctly picks up newly appended events, without disturbing previously-counted workspaces', async () => {
      const workspaceC = await createWorkspace('rebuild-determinism-c-incremental');
      const streamC = crypto.randomUUID();

      const checkpointBeforeIncrement = await getCheckpoint(projection.name);

      await eventStore.append(streamC, 0, [buildNewEvent({ workspaceId: workspaceC, type: 'C1' })]);
      await eventStore.append(streamC, 1, [buildNewEvent({ workspaceId: workspaceC, type: 'C2' })]);
      await eventStore.append(streamC, 2, [buildNewEvent({ workspaceId: workspaceC, type: 'C3' })]);

      await projectionRunner.catchUp(projection);

      const counts = await getEventCounts();
      expect(counts[workspaceC]).toBe(3);
      // Previously-processed workspaces must be untouched by the incremental
      // catch-up — it must only apply the NEW events, not reprocess old ones.
      expect(counts[workspaceA]).toBe(3);
      expect(counts[workspaceB]).toBe(2);

      const checkpointAfterIncrement = await getCheckpoint(projection.name);
      expect(checkpointAfterIncrement).toBeGreaterThan(checkpointBeforeIncrement ?? 0);
    });
  });
});
