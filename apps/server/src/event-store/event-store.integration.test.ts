import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VersionConflictError } from '@luminaos/shared';
import type { DomainEvent, NewDomainEvent } from '@luminaos/shared';

import { EventStoreConsistencyError } from './event-store-consistency.error.js';
import { EventStoreService } from './event-store.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { StoredEvent } from './event-store.service.js';
import type { Database } from '../db/client.js';

/**
 * Real integration test against a throwaway Postgres 16 container (no
 * mocking), proving F0-T6 PR-A's core hard problem: optimistic concurrency
 * (AC1), idempotent replay (AC2), and stream ordering + workspace isolation
 * + `readByWorkspace` cursor pagination (AC3) — all against the real unique
 * constraints, not simulated.
 *
 * `EventStoreService` has no controller/HTTP surface yet (per the plan, PR-A
 * ships it as a plain injectable service), so it is constructed directly
 * against a real Drizzle `Database` client rather than driven through Nest
 * DI/HTTP, mirroring how `WorkspacesService` takes its `Database` via
 * constructor injection.
 *
 * A real `workspaces` row is required to satisfy `events.workspace_id`'s FK
 * (`ON DELETE NO ACTION` per the plan) — inserted directly via the injected
 * Drizzle client, not through the workspaces HTTP API (there's no session/user
 * plumbing needed for this test).
 *
 * ASSUMPTION (implementer: adjust this test if wrong, per the plan's design
 * note): since `readByWorkspace(workspaceId, fromPosition)` must return
 * `DomainEvent[]` per its declared signature, but the pagination cursor
 * described in the spec ("read again using the last returned event's
 * position") requires each returned event to carry the `events` table's
 * `global_position` column, this test assumes the objects returned by
 * `readByWorkspace` carry a `globalPosition: number` property *in addition to*
 * the base `DomainEvent` shape (structurally compatible with, but richer
 * than, `DomainEvent`). If the implementer's actual design differs (e.g. a
 * `{ events, nextPosition }` wrapper), this test's pagination assertions will
 * need to be updated to match — flagged explicitly rather than guessed away.
 */

interface DomainEventWithPosition extends DomainEvent {
  globalPosition: number;
}

function buildNewEvent(
  overrides: Partial<NewDomainEvent> & { workspaceId: string },
): NewDomainEvent {
  return {
    id: crypto.randomUUID(),
    streamType: 'test-stream',
    type: 'TestEventOccurred',
    payload: { foo: 'bar' },
    actor: { type: 'user', id: crypto.randomUUID() },
    occurredAt: new Date(),
    ...overrides,
  } satisfies NewDomainEvent;
}

describe('EventStoreService (real Postgres via Testcontainers)', () => {
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

  describe('AC1: optimistic concurrency', () => {
    it('rejects a stale expectedVersion with VersionConflictError (sequential append)', async () => {
      const workspaceId = await createWorkspace('ac1-sequential');
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [buildNewEvent({ workspaceId })]);

      // Second append still claims expectedVersion=0, but the stream is now
      // at version 1 — this must be rejected, not silently accepted.
      await expect(
        eventStore.append(streamId, 0, [buildNewEvent({ workspaceId })]),
      ).rejects.toBeInstanceOf(VersionConflictError);

      // The rejected append must not have left a partial/second row behind.
      const persisted = await eventStore.readStream(streamId);
      expect(persisted).toHaveLength(1);
    });

    it('when two concurrent appends race for expectedVersion=0 on the same stream, exactly one succeeds and the other is rejected with VersionConflictError', async () => {
      const workspaceId = await createWorkspace('ac1-concurrent');
      const streamId = crypto.randomUUID();

      const results = await Promise.allSettled([
        eventStore.append(streamId, 0, [buildNewEvent({ workspaceId, type: 'RaceA' })]),
        eventStore.append(streamId, 0, [buildNewEvent({ workspaceId, type: 'RaceB' })]),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<StoredEvent[]> => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(VersionConflictError);

      // Only the winning append's event made it into the stream.
      const persisted = await eventStore.readStream(streamId);
      expect(persisted).toHaveLength(1);
    });
  });

  describe('AC2: idempotent replay', () => {
    it('re-appending the exact same event id/streamId/expectedVersion is a no-op that returns the originally stored event, not a duplicate row', async () => {
      const workspaceId = await createWorkspace('ac2-idempotent-replay');
      const streamId = crypto.randomUUID();
      const event = buildNewEvent({ workspaceId, type: 'IdempotentEvent' });

      const [firstAppendResult] = await eventStore.append(streamId, 0, [event]);
      expect(firstAppendResult).toBeDefined();

      // Exact same id, same streamId, same (now-stale-looking, but originally
      // correct) expectedVersion=0 — must not throw, must be a no-op.
      const secondAppendResult = await eventStore.append(streamId, 0, [event]);
      const [replayedEvent] = secondAppendResult;

      expect(replayedEvent).toEqual(firstAppendResult);
      expect(replayedEvent?.id).toBe(event.id);
      expect(replayedEvent?.version).toBe(firstAppendResult?.version);

      const stream = await eventStore.readStream(streamId);
      expect(stream).toHaveLength(1);
      expect(stream[0]?.id).toBe(event.id);
    });
  });

  describe('AC3: ordering, workspace isolation, and readByWorkspace pagination', () => {
    it('readStream returns events in ascending version order with sequential version numbers assigned (1, 2, 3, ...)', async () => {
      const workspaceId = await createWorkspace('ac3-ordering');
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [buildNewEvent({ workspaceId, type: 'FirstEvent' })]);
      await eventStore.append(streamId, 1, [buildNewEvent({ workspaceId, type: 'SecondEvent' })]);
      await eventStore.append(streamId, 2, [buildNewEvent({ workspaceId, type: 'ThirdEvent' })]);

      const stream = await eventStore.readStream(streamId);

      expect(stream.map((event) => event.version)).toEqual([1, 2, 3]);
      expect(stream.map((event) => event.type)).toEqual([
        'FirstEvent',
        'SecondEvent',
        'ThirdEvent',
      ]);
    });

    it("readByWorkspace only returns the given workspace's events, never another workspace's", async () => {
      const workspaceA = await createWorkspace('ac3-isolation-a');
      const workspaceB = await createWorkspace('ac3-isolation-b');

      const streamA = crypto.randomUUID();
      const streamB = crypto.randomUUID();

      await eventStore.append(streamA, 0, [
        buildNewEvent({ workspaceId: workspaceA, type: 'WorkspaceAEvent' }),
      ]);
      await eventStore.append(streamB, 0, [
        buildNewEvent({ workspaceId: workspaceB, type: 'WorkspaceBEvent' }),
      ]);

      const eventsForA = await eventStore.readByWorkspace(workspaceA, 0);

      expect(eventsForA.length).toBeGreaterThan(0);
      expect(eventsForA.every((event) => event.workspaceId === workspaceA)).toBe(true);
      expect(eventsForA.some((event) => event.type === 'WorkspaceBEvent')).toBe(false);
    });

    it('readByWorkspace fromPosition is an exclusive cursor: re-reading from the last-seen position returns nothing further until new events are appended', async () => {
      const workspaceId = await createWorkspace('ac3-pagination');
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [buildNewEvent({ workspaceId, type: 'PageOne' })]);
      await eventStore.append(streamId, 1, [buildNewEvent({ workspaceId, type: 'PageTwo' })]);

      const firstPage = (await eventStore.readByWorkspace(
        workspaceId,
        0,
      )) as DomainEventWithPosition[];
      expect(firstPage).toHaveLength(2);

      const lastEvent = firstPage[firstPage.length - 1];
      if (!lastEvent) {
        throw new Error('Expected firstPage to contain at least one event.');
      }
      const lastSeenPosition: number = lastEvent.globalPosition;
      expect(typeof lastSeenPosition).toBe('number');

      const emptyNextPage = await eventStore.readByWorkspace(workspaceId, lastSeenPosition);
      expect(emptyNextPage).toHaveLength(0);

      // Appending a new event after the cursor must show up on a subsequent
      // read from the same cursor position.
      await eventStore.append(streamId, 2, [buildNewEvent({ workspaceId, type: 'PageThree' })]);

      const thirdPage = await eventStore.readByWorkspace(workspaceId, lastSeenPosition);
      expect(thirdPage).toHaveLength(1);
      expect(thirdPage[0]?.type).toBe('PageThree');
    });
  });

  describe('regression: cross-stream global-id collision must not silently drop a write', () => {
    // `events.id` is a GLOBAL primary key, not scoped to `streamId`. `append`
    // uses `INSERT ... ON CONFLICT (id) DO NOTHING`, then — when nothing was
    // inserted — reloads via `loadByIds(tx, streamId, ids)`, which filters by
    // the CURRENT streamId. If the colliding id's row actually lives under a
    // *different* streamId, that reload finds nothing, `existing` is `[]`,
    // and `append` resolves successfully with `[]` — the caller's write is
    // silently lost: no exception, no partial-collision error, nothing.
    //
    // This must instead be treated as a real conflict/invariant violation and
    // throw (e.g. `EventStoreConsistencyError`, mirroring the partial-batch-
    // collision guard a few lines above it in `append`), never resolve
    // successfully with a silently-dropped write.
    it('rejects appending an event whose id already exists under a different stream, instead of silently returning an empty result', async () => {
      const workspaceId = await createWorkspace('regression-cross-stream-id-collision');
      const streamOne = crypto.randomUUID();
      const streamTwo = crypto.randomUUID();

      const collidingId = crypto.randomUUID();

      // Step 1: a normal, legitimate first write to streamOne using
      // `collidingId`.
      await eventStore.append(streamOne, 0, [
        buildNewEvent({
          id: collidingId,
          workspaceId,
          type: 'StreamOneOriginalEvent',
          payload: { origin: 'streamOne' },
        }),
      ]);

      // Step 2: streamTwo is empty, so appending at expectedVersion=0 looks
      // like a legitimate first write — but it reuses `collidingId`, which
      // already exists globally (under streamOne, not streamTwo).
      const conflictingAppend = eventStore.append(streamTwo, 0, [
        buildNewEvent({
          id: collidingId,
          workspaceId,
          type: 'StreamTwoConflictingEvent',
          payload: { origin: 'streamTwo' },
        }),
      ]);

      // This must be rejected loudly, not resolve as a silent no-op with `[]`.
      await expect(conflictingAppend).rejects.toBeInstanceOf(EventStoreConsistencyError);

      // Whether it throws or not, streamTwo must never end up with a
      // silently wrong/partial row standing in for the rejected write.
      const streamTwoContents = await eventStore.readStream(streamTwo);
      expect(streamTwoContents).toHaveLength(0);

      // streamOne's original event must remain untouched.
      const streamOneContents = await eventStore.readStream(streamOne);
      expect(streamOneContents).toHaveLength(1);
      expect(streamOneContents[0]?.type).toBe('StreamOneOriginalEvent');
    });
  });
});
