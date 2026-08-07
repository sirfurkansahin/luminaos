import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ObjectsViewProjection } from './objects-view.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR3 (RED step) — plan section "PR3 — Backend: `timeblock`'ın
 * `start`/`end` alanlarını `objects_view` projeksiyonunda kalıcı hale
 * getir + `blocks-time-for` ilişki türü" (mirrors F1-T10 PR6a's own
 * precedent: projection-extension-before-routes — this PR adds NO new HTTP
 * route for writing a `timeblock`'s schedule; every `TimeBlockScheduled`/
 * `TimeBlockCleared` event below is appended directly via
 * `EventStoreService.append`, bypassing HTTP entirely, exactly like
 * `checklist-recurrence-projection.integration.test.ts` does for
 * `RecurrenceRuleSet`/`Cleared`).
 *
 * `packages/core-objects`'s `scheduleTimeBlock`/`clearTimeBlockSchedule`
 * (F1-T12 PR2) already produce `TimeBlockScheduled`/`TimeBlockCleared`
 * domain events, and `replayObject` already folds them correctly. What does
 * NOT exist yet, on the SERVER side (this PR's designed contract):
 *
 *   A. `db/schema/objects-view.ts` has no `time_block_start`/
 *      `time_block_end` columns at all (no migration adds them). Per the
 *      plan, these are PLAIN nullable `timestamp with time zone` columns
 *      (NOT jsonb, unlike `recurrenceRule`) — `timeBlockStart`/
 *      `timeBlockEnd` Drizzle fields mapping to SQL columns
 *      `time_block_start`/`time_block_end` (the bare word `end` is a SQL
 *      reserved word, hence the `time_block_` prefix on both for
 *      symmetry). Both nullable, no default — NULL means "no schedule set"
 *      (mirrors `recurrenceRule`'s convention, not `checklist`'s).
 *
 *   B. `ObjectsViewProjection.handles` (`objects-view.projection.ts`) does
 *      not list `TimeBlockScheduled`/`TimeBlockCleared` — they silently
 *      fall through to `default: return` (a no-op), so `catchUp` never
 *      writes anything for them even once the columns exist. The designed
 *      `apply()` cases:
 *        - `TimeBlockScheduled`: extract+validate `start`/`end` as
 *          non-empty string payload fields (mirroring
 *          `parseRecurrenceRulePayload`'s defensive style), then
 *          `UPDATE objectsView SET timeBlockStart = <parsed start>,
 *          timeBlockEnd = <parsed end>, updatedAt = event.occurredAt WHERE
 *          id = objectId`.
 *        - `TimeBlockCleared`: `UPDATE objectsView SET timeBlockStart =
 *          null, timeBlockEnd = null, updatedAt = event.occurredAt WHERE id
 *          = objectId`.
 *
 *   C. `ObjectsService.toLuminaObject()` (`objects.service.ts`) never reads
 *      `row.timeBlockStart`/`row.timeBlockEnd` — even once (A) and (B) are
 *      fixed, the read path itself would still ignore the data. Designed:
 *      if BOTH columns are non-null, set
 *      `timeBlock: { start: row.timeBlockStart.toISOString(), end:
 *      row.timeBlockEnd.toISOString() }` on the returned object; if EITHER
 *      is null, `timeBlock` is OMITTED entirely (never `null`, never an
 *      `undefined`-valued key) — mirrors `recurrenceRule`'s
 *      optional-spread convention.
 *
 * ============================================================================
 * EXPECTED RED STATE (today, before `implementer` touches
 * `db/schema/objects-view.ts` / a new migration / `objects-view.projection.ts`
 * / `objects.service.ts`):
 *
 *   - Every assertion that reads `timeBlock` via the HTTP `GET` route fails
 *     as a plain Vitest assertion mismatch: `object.timeBlock` is always
 *     `undefined` (the field is never set), never the expected
 *     `{ start, end }`.
 *   - The raw-row test fails differently: the `rawDb.$client.query(...)`
 *     call itself REJECTS with a real Postgres error (`column
 *     "time_block_start" does not exist`), before any `expect(...)` in that
 *     test even runs.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectBody {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  timeBlock?: { start: string; end: string };
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface RawTimeBlockRow {
  time_block_start: Date | null;
  time_block_end: Date | null;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `timeblock-projection-test-user-${String(emailCounter)}@example.com`;
}

/** The actor recorded on every event this file appends directly via `EventStoreService.append` (bypassing HTTP, which has no writer route for timeblock scheduling yet). */
const DIRECT_APPEND_ACTOR: Actor = { type: 'system', id: 'timeblock-projection-test' };

describe('F1-T12 PR3 (RED step): objects_view timeBlockStart/timeBlockEnd projection (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the
    // established convention in every other integration test file here.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());

    eventStore = app.get(EventStoreService);
    projectionRunner = app.get(ProjectionRunner);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerUser(): Promise<string> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    return toCookieHeader(response.get('Set-Cookie'));
  }

  async function createWorkspace(cookie: string): Promise<string> {
    const response = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Timeblock projection test ${String(emailCounter)}` });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await registerUser();
    const workspaceId = await createWorkspace(cookie);
    return { cookie, workspaceId };
  }

  function objectsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects`;
  }

  async function getObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .get(`${objectsUrl(workspaceId)}/${objectId}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    return (response.body as ObjectEnvelope).object;
  }

  /** A FRESH `ObjectsViewProjection` instance is fine -- `ProjectionRunner.catchUp` checkpoints by `projection.name`, not instance identity. */
  async function catchUpObjectsViewProjection(): Promise<void> {
    await projectionRunner.catchUp(new ObjectsViewProjection());
  }

  /**
   * Appends a single event directly to `streamId` via `EventStoreService`,
   * bypassing HTTP entirely. Reads the stream first to compute the correct
   * `expectedVersion`, mirroring the checklist/recurrence-rule projection
   * test's own `appendEvent` helper.
   */
  async function appendEvent(
    streamId: string,
    workspaceId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const priorEvents = await eventStore.readStream(streamId);
    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: 'lumina-object',
      workspaceId,
      type,
      payload,
      actor: DIRECT_APPEND_ACTOR,
      occurredAt: new Date(),
    };

    await eventStore.append(streamId, priorEvents.length, [event]);
  }

  /**
   * Creates a brand-new `timeblock` (or any other) LuminaObject by
   * appending its `ObjectCreated` event DIRECTLY, bypassing the HTTP
   * `POST .../objects` route entirely -- deliberate, because
   * `create-object.schema.ts`'s `objectType` enum does not (yet, as of this
   * PR) include `'timeblock'`, and going through that route would fail for
   * an unrelated reason (DTO validation) rather than the reason this PR's
   * RED step is actually about (the projection/service not persisting
   * `timeBlock`). This mirrors this same test suite's convention of
   * appending domain events directly wherever no HTTP writer route exists
   * yet.
   */
  async function createObjectDirect(
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<{ objectId: string; streamId: string }> {
    const objectId = newObjectId();
    const streamId = crypto.randomUUID();

    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: 'lumina-object',
      workspaceId,
      type: 'ObjectCreated',
      payload: { objectId, objectType, title },
      actor: DIRECT_APPEND_ACTOR,
      occurredAt: new Date(),
    };

    await eventStore.append(streamId, 0, [event]);
    await catchUpObjectsViewProjection();

    return { objectId, streamId };
  }

  /**
   * Reads `time_block_start`/`time_block_end` straight off the
   * `objects_view` row via the raw `pg` driver (`rawDb.$client`), NOT via
   * Drizzle's typed `objectsView` schema object -- same rationale as
   * `checklist-recurrence-projection.integration.test.ts`'s own raw-row
   * helper: a typed `objectsView.timeBlockStart` reference would fail
   * `pnpm typecheck` FOREVER (the column doesn't exist on the schema yet)
   * until this file were also edited once the columns land, defeating the
   * point of a RED step that turns cleanly GREEN with zero further edits
   * to this test file. The raw query instead fails at RUNTIME today (a
   * genuine Postgres `column "time_block_start" does not exist` error) and
   * will simply return real data once the migration exists.
   */
  async function readRawTimeBlock(
    objectId: string,
  ): Promise<{ start: Date | null; end: Date | null }> {
    const result = await rawDb.$client.query<RawTimeBlockRow>(
      'select time_block_start, time_block_end from objects_view where id = $1',
      [objectId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`objects_view row not found for object ${objectId}`);
    }

    return { start: row.time_block_start, end: row.time_block_end };
  }

  describe('AC1: TimeBlockScheduled folds into the real `timeBlock` field returned by GET .../objects/:objectId', () => {
    it('a scheduled timeblock -- GET returns timeBlock.start/end matching the event payload (compared by timestamp, not string equality)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Focus block',
      );

      const start = '2026-03-01T09:00:00.000Z';
      const end = '2026-03-01T10:00:00.000Z';

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', { objectId, start, end });
      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, objectId);

      expect(object.timeBlock).toBeDefined();
      expect(new Date(object.timeBlock?.start ?? '').getTime()).toBe(new Date(start).getTime());
      expect(new Date(object.timeBlock?.end ?? '').getTime()).toBe(new Date(end).getTime());
    });
  });

  describe('AC2: TimeBlockCleared resets both columns to NULL', () => {
    it('after scheduling then clearing, GET returns timeBlock as undefined and the raw columns are both NULL', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Cleared block',
      );

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', {
        objectId,
        start: '2026-03-02T09:00:00.000Z',
        end: '2026-03-02T10:00:00.000Z',
      });
      await catchUpObjectsViewProjection();

      const afterSet = await getObject(cookie, workspaceId, objectId);
      expect(afterSet.timeBlock).toBeDefined();

      await appendEvent(streamId, workspaceId, 'TimeBlockCleared', { objectId });
      await catchUpObjectsViewProjection();

      const afterClear = await getObject(cookie, workspaceId, objectId);
      expect(afterClear.timeBlock).toBeUndefined();

      const raw = await readRawTimeBlock(objectId);
      expect(raw.start).toBeNull();
      expect(raw.end).toBeNull();
    });
  });

  describe('AC3: rescheduling overwrites the prior schedule entirely', () => {
    it('two TimeBlockScheduled events -- the row reflects only the SECOND (latest) schedule', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Reschedule block',
      );

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', {
        objectId,
        start: '2026-03-03T09:00:00.000Z',
        end: '2026-03-03T10:00:00.000Z',
      });
      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', {
        objectId,
        start: '2026-03-03T14:00:00.000Z',
        end: '2026-03-03T15:30:00.000Z',
      });

      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, objectId);

      expect(new Date(object.timeBlock?.start ?? '').getTime()).toBe(
        new Date('2026-03-03T14:00:00.000Z').getTime(),
      );
      expect(new Date(object.timeBlock?.end ?? '').getTime()).toBe(
        new Date('2026-03-03T15:30:00.000Z').getTime(),
      );
    });
  });

  describe('AC4 regression: an unrelated event does not touch timeBlockStart/timeBlockEnd', () => {
    it('an ObjectRenamed event appended after scheduling leaves the raw timeBlock columns unchanged', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Untouched block',
      );

      const start = '2026-03-04T09:00:00.000Z';
      const end = '2026-03-04T10:00:00.000Z';

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', { objectId, start, end });
      await catchUpObjectsViewProjection();

      const beforeRename = await readRawTimeBlock(objectId);
      expect(beforeRename.start).not.toBeNull();
      expect(beforeRename.end).not.toBeNull();

      await appendEvent(streamId, workspaceId, 'ObjectRenamed', {
        objectId,
        title: 'Renamed, still the same block',
      });
      await catchUpObjectsViewProjection();

      const afterRename = await readRawTimeBlock(objectId);

      expect(afterRename.start?.getTime()).toBe(new Date(start).getTime());
      expect(afterRename.end?.getTime()).toBe(new Date(end).getTime());
    });
  });

  describe('AC5: ObjectsService.toLuminaObject() shape -- timeBlock present only when actually scheduled', () => {
    it('a scheduled timeblock has timeBlock: {start, end} as ISO strings', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Shape check block',
      );

      const start = '2026-03-05T09:00:00.000Z';
      const end = '2026-03-05T10:00:00.000Z';

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', { objectId, start, end });
      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, objectId);

      expect(typeof object.timeBlock?.start).toBe('string');
      expect(typeof object.timeBlock?.end).toBe('string');
      expect(new Date(object.timeBlock?.start ?? '').getTime()).toBe(new Date(start).getTime());
      expect(new Date(object.timeBlock?.end ?? '').getTime()).toBe(new Date(end).getTime());
    });

    it('a task object whose timeBlock fields were never set has timeBlock OMITTED entirely (not null, not an undefined-valued key)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const { objectId } = await createObjectDirect(workspaceId, 'task', 'Plain task');

      const object = await getObject(cookie, workspaceId, objectId);

      expect('timeBlock' in object).toBe(false);
      expect(object.timeBlock).toBeUndefined();
    });
  });

  describe('raw `objects_view` row (bypassing ObjectsService/HTTP entirely)', () => {
    it('the persisted `time_block_start`/`time_block_end` columns carry the same schedule the HTTP GET response returns', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Raw row check block',
      );

      const start = '2026-03-06T09:00:00.000Z';
      const end = '2026-03-06T10:00:00.000Z';

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', { objectId, start, end });
      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, objectId);
      const raw = await readRawTimeBlock(objectId);

      expect(raw.start).not.toBeNull();
      expect(raw.end).not.toBeNull();
      expect(raw.start?.getTime()).toBe(new Date(start).getTime());
      expect(raw.end?.getTime()).toBe(new Date(end).getTime());
      expect(raw.start?.getTime()).toBe(new Date(object.timeBlock?.start ?? '').getTime());
      expect(raw.end?.getTime()).toBe(new Date(object.timeBlock?.end ?? '').getTime());
    });
  });

  // MUST run LAST, and MUST be the only case that rejects an event: once a
  // malformed event is appended and its `catchUp` call rejects, the
  // projection's checkpoint (persisted in `projection_checkpoints`, scoped
  // by projection name) does NOT advance past it -- every SUBSEQUENT
  // `catchUpObjectsViewProjection()` call in this shared Postgres container
  // (including the one inside `createObjectDirect`) would keep hitting that
  // SAME poisoned event first and rejecting, so a second such case in the
  // same file/container is untestable without a full checkpoint reset. One
  // case, placed last, is sufficient to prove the fold re-validates its
  // invariant rather than trusting the command layer.
  describe('defense-in-depth: a malformed TimeBlockScheduled event is rejected during catchUp, not silently folded', () => {
    it('rejects end <= start (mirrors the fix applied to packages/core-objects/src/replay.ts after the F1-T12 PR2 security review)', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();
      const { objectId, streamId } = await createObjectDirect(
        workspaceId,
        'timeblock',
        'Malformed range block',
      );

      await appendEvent(streamId, workspaceId, 'TimeBlockScheduled', {
        objectId,
        start: '2026-03-07T10:00:00.000Z',
        end: '2026-03-07T09:00:00.000Z',
      });

      await expect(catchUpObjectsViewProjection()).rejects.toThrow();

      const raw = await readRawTimeBlock(objectId);
      expect(raw.start).toBeNull();
      expect(raw.end).toBeNull();
    });
  });
});
