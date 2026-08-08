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
 * Permanent regression test (real Postgres via Testcontainers, no mocking)
 * for the concurrency bug found and fixed during F1-T13, already merged to
 * `main` — this suite is deliberately NOT scoped to that feature; it belongs
 * to `ProjectionRunner`'s own shared test suite and must keep passing
 * regardless of which feature next touches catch-up.
 *
 * The bug: `ProjectionRunner.catchUp(projection)` used to read a
 * projection's checkpoint via a plain unlocked `SELECT`, then apply batches
 * of events and advance the checkpoint in a separate transaction. Two
 * CONCURRENT `catchUp()` calls for the SAME projection (keyed by
 * `projection.name` in `projection_checkpoints`) could both read the same
 * stale checkpoint before either wrote an advanced one, and both then apply
 * the SAME batch of events — double-applying them. For an idempotent-looking
 * upsert like `WorkspaceEventCounterProjection.apply()`
 * (`event_count = event_count + 1` on conflict), double-application doesn't
 * crash — it silently INFLATES the count, which makes it a precise,
 * deterministic detector for this bug (unlike a plain-INSERT projection,
 * where double-application crashes with a duplicate-key violation instead).
 *
 * The fix (see `projection-runner.service.ts`'s `catchUp` doc comment): the
 * ENTIRE call (checkpoint read through every batch's apply + checkpoint
 * write) now runs inside ONE `db.transaction()`, serialized per
 * `projection.name` via a Postgres transaction-scoped advisory lock
 * (`pg_advisory_xact_lock(hashtext(name)::bigint)`).
 *
 * This suite proves the lock is enforced at the DATABASE level, not merely
 * by JS-object identity, by driving TWO (and, in the stress test, up to
 * five) separate `ProjectionRunner` instances — each with its OWN
 * `WorkspaceEventCounterProjection` instance (same `.name`, different object
 * identity) — concurrently against the same log, and asserting the
 * resulting `event_count` is EXACT: never inflated by double-application,
 * never short from a dropped event.
 *
 * Mirrors `projection-rebuild.integration.test.ts`'s lightweight
 * Testcontainers/`runMigrations`/`createDatabaseClient` harness convention
 * (plain classes constructed directly, no Nest DI container needed).
 */

function buildNewEvent(
  overrides: Partial<NewDomainEvent> & { workspaceId: string },
): NewDomainEvent {
  return {
    id: crypto.randomUUID(),
    streamType: 'test-stream',
    type: 'TestEventOccurred',
    payload: { foo: 'bar' },
    actor: { type: 'system', id: 'projection-runner-concurrency-test' },
    occurredAt: new Date(),
    ...overrides,
  } satisfies NewDomainEvent;
}

describe('ProjectionRunner.catchUp() concurrency (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
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

  async function getEventCount(workspaceId: string): Promise<number | undefined> {
    const [row] = await db
      .select({ eventCount: projectionWorkspaceEventCounts.eventCount })
      .from(projectionWorkspaceEventCounts)
      .where(eq(projectionWorkspaceEventCounts.workspaceId, workspaceId));

    return row?.eventCount;
  }

  async function getCheckpoint(projectionName: string): Promise<number | undefined> {
    const [row] = await db
      .select({ lastPosition: projectionCheckpoints.lastPosition })
      .from(projectionCheckpoints)
      .where(eq(projectionCheckpoints.projectionName, projectionName));

    return row?.lastPosition;
  }

  /**
   * Appends `count` sequential events (versions `startVersion + 1` through
   * `startVersion + count`) to `streamId`, returning the true final
   * `globalPosition` assigned to the last one — the exact value a correctly
   * advanced checkpoint must equal afterwards.
   */
  async function appendEvents(
    workspaceId: string,
    streamId: string,
    startVersion: number,
    count: number,
  ): Promise<number> {
    let lastGlobalPosition: number | undefined;

    for (let index = 0; index < count; index += 1) {
      const [stored] = await eventStore.append(streamId, startVersion + index, [
        buildNewEvent({ workspaceId, type: `Event${String(startVersion + index + 1)}` }),
      ]);

      if (!stored) {
        throw new Error('Expected eventStore.append() to return the stored event.');
      }

      lastGlobalPosition = stored.globalPosition;
    }

    if (lastGlobalPosition === undefined) {
      throw new Error('Expected at least one event to be appended.');
    }

    return lastGlobalPosition;
  }

  describe('two concurrent catchUp() calls for the same projection never double-apply events', () => {
    let workspaceId: string;
    let streamId: string;
    let runnerA: ProjectionRunner;
    let runnerB: ProjectionRunner;
    let projectionA: WorkspaceEventCounterProjection;
    let projectionB: WorkspaceEventCounterProjection;

    beforeAll(async () => {
      workspaceId = await createWorkspace('projection-runner-concurrency-two-callers');
      streamId = crypto.randomUUID();

      // Same db/eventStore, two separate runner instances, two separate
      // projection instances sharing the same `.name` — proves the advisory
      // lock keys off `projection.name` (a string), not object identity.
      runnerA = new ProjectionRunner(db, eventStore);
      runnerB = new ProjectionRunner(db, eventStore);
      projectionA = new WorkspaceEventCounterProjection();
      projectionB = new WorkspaceEventCounterProjection();
    });

    it('applies exactly 20 events once each when two catchUp() calls race for the same projection name', async () => {
      const expectedFinalPosition = await appendEvents(workspaceId, streamId, 0, 20);

      try {
        await Promise.all([runnerA.catchUp(projectionA), runnerB.catchUp(projectionB)]);
      } catch (error) {
        throw new Error(
          `Expected both concurrent catchUp() calls to resolve without throwing, but at least one rejected: ${String(error)}`,
          { cause: error },
        );
      }

      const eventCount = await getEventCount(workspaceId);
      // Exactly 20, not more (would prove double-application via the racing
      // stale-checkpoint bug) and not less (would prove events were dropped).
      expect(eventCount).toBe(20);

      const checkpoint = await getCheckpoint(projectionA.name);
      expect(checkpoint).toBe(expectedFinalPosition);
    });

    it('a further round of concurrent catchUp() calls after more events are appended keeps advancing correctly, without inflating the count or corrupting the checkpoint', async () => {
      const expectedFinalPosition = await appendEvents(workspaceId, streamId, 20, 10);

      try {
        await Promise.all([runnerA.catchUp(projectionA), runnerB.catchUp(projectionB)]);
      } catch (error) {
        throw new Error(
          `Expected both concurrent catchUp() calls to resolve without throwing, but at least one rejected: ${String(error)}`,
          { cause: error },
        );
      }

      const eventCount = await getEventCount(workspaceId);
      expect(eventCount).toBe(30);

      const checkpoint = await getCheckpoint(projectionA.name);
      expect(checkpoint).toBe(expectedFinalPosition);
    });
  });

  describe('more than two concurrent catchUp() callers for the same projection', () => {
    let workspaceId: string;
    let streamId: string;

    beforeAll(async () => {
      workspaceId = await createWorkspace('projection-runner-concurrency-five-callers');
      streamId = crypto.randomUUID();
    });

    it('applies exactly 25 events once each under 5 concurrent catchUp() calls across a mix of shared and separate runner/projection instances', async () => {
      const expectedFinalPosition = await appendEvents(workspaceId, streamId, 0, 25);

      const sharedRunner = new ProjectionRunner(db, eventStore);
      const sharedProjection = new WorkspaceEventCounterProjection();

      const callers: Promise<void>[] = [
        // Same runner instance, driven twice concurrently with two different
        // projection instances of the same name.
        sharedRunner.catchUp(sharedProjection),
        sharedRunner.catchUp(new WorkspaceEventCounterProjection()),
        // Three fully independent runner + projection instances.
        new ProjectionRunner(db, eventStore).catchUp(new WorkspaceEventCounterProjection()),
        new ProjectionRunner(db, eventStore).catchUp(new WorkspaceEventCounterProjection()),
        new ProjectionRunner(db, eventStore).catchUp(new WorkspaceEventCounterProjection()),
      ];

      try {
        await Promise.all(callers);
      } catch (error) {
        throw new Error(
          `Expected all 5 concurrent catchUp() calls to resolve without throwing, but at least one rejected: ${String(error)}`,
          { cause: error },
        );
      }

      const eventCount = await getEventCount(workspaceId);
      expect(eventCount).toBe(25);

      const checkpoint = await getCheckpoint(sharedProjection.name);
      expect(checkpoint).toBe(expectedFinalPosition);
    });
  });
});
