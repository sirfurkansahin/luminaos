import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ObjectsViewProjection } from './objects-view.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { objectsView } from '../db/schema/objects-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T10 PR6a (RED step) — plan `precious-roaming-harbor.md`, section
 * "PR6a — Backend: `objects_view` projeksiyonunu genişlet":
 *
 *   "GET .../objects/:objectId (ve list/query) gerçek checklist/recurrenceRule
 *   döndürsün — checklist: [] placeholder'ı kapatılır."
 *
 * `packages/core-objects`'s `addChecklistItem`/`toggleChecklistItem`/
 * `removeChecklistItem`/`reorderChecklistItem` (PR2, #35) and
 * `setRecurrenceRule`/`clearRecurrenceRule` (PR4, #40) already produce
 * `ChecklistItemAdded/Toggled/Removed/Reordered` and
 * `RecurrenceRuleSet/Cleared` domain events, and `replayObject` already folds
 * them correctly (property-tested). What does NOT exist yet, on the SERVER
 * side:
 *
 *   1. `objects_view` has no `checklist`/`recurrence_rule` columns at all
 *      (`db/schema/objects-view.ts`) — no migration has added them.
 *   2. `ObjectsViewProjection.handles` (`objects-view.projection.ts`) does not
 *      list any of the six event types above — they silently fall through to
 *      `default: return` (a no-op), so `catchUp` never writes anything for
 *      them even once the columns exist.
 *   3. `ObjectsService.toLuminaObject()` (`objects.service.ts`) hardcodes
 *      `checklist: []` and never reads/sets `recurrenceRule` — even once (1)
 *      and (2) are fixed, the read path itself would still ignore the data.
 *
 * This PR does NOT add any HTTP route for WRITING checklist/recurrence-rule
 * (that's PR6b) — every event below is appended directly via
 * `EventStoreService.append`, bypassing HTTP entirely, then
 * `ProjectionRunner.catchUp` is run synchronously (mirrors
 * `ObjectsService.applyCommand`'s own "append, then catchUp" sequencing).
 * Reading back goes through TWO independent paths, on purpose:
 *
 *   - The real HTTP `GET /workspaces/:workspaceId/objects/:objectId` route
 *     (already wired, unrelated to this PR) — this is what proves
 *     `ObjectsService.get()` (and therefore `toLuminaObject()`) returns the
 *     real folded state, not the `[]` placeholder.
 *   - A raw, PARAMETERIZED `objects_view` row read via the underlying `pg`
 *     driver (`rawDb.$client.query(...)`), deliberately NOT going through
 *     Drizzle's typed `objectsView` schema object for the `checklist`/
 *     `recurrence_rule` columns themselves (only `streamId`, which already
 *     exists, is read via the typed schema). This is intentional: a typed
 *     `objectsView.checklist` reference would fail `pnpm typecheck` today
 *     (the column doesn't exist on the schema yet) in a way that would keep
 *     failing typecheck FOREVER even after `implementer` adds the migration,
 *     unless this file were also edited then — which defeats the point of a
 *     RED step that turns cleanly GREEN once PR6a's actual implementation
 *     (schema + migration + projection + service) lands with zero further
 *     edits to this test file. The raw query instead fails at RUNTIME today
 *     (a genuine Postgres `column "checklist" does not exist` error,
 *     surfaced as the `it` block's own failure) and will simply return real
 *     data once the migration exists — no test-file edit needed either way.
 *
 * ============================================================================
 * EXPECTED RED STATE (today, before `implementer` touches
 * `db/schema/objects-view.ts` / a new migration / `objects-view.projection.ts`
 * / `objects.service.ts`):
 *
 *   - Every assertion that reads `checklist` via the HTTP `GET` route fails
 *     as a plain Vitest assertion mismatch: `object.checklist` is always `[]`
 *     (the hardcoded placeholder), never the expected folded array.
 *   - Every assertion that reads `recurrenceRule` via the HTTP `GET` route
 *     fails the same way: `object.recurrenceRule` is always `undefined`
 *     (never set), even right after a `RecurrenceRuleSet` event.
 *   - The raw-row test fails differently: the `rawDb.$client.query(...)` call
 *     itself REJECTS with a real Postgres error (`column "checklist" does not
 *     exist`), before any `expect(...)` in that test even runs.
 *
 * `implementer`'s job (this same PR) is exactly the plan's three bullets
 * above: add the two nullable/defaulted columns + migration (with a down
 * script), add the six event types to `ObjectsViewProjection.handles` with a
 * read-modify-write JS-side fold for the checklist array (a single-key
 * `jsonb_set` is not enough — reorder/toggle/remove all need to
 * inspect/mutate the array's existing contents, not just replace one key),
 * and make `toLuminaObject()` read `row.checklist`/`row.recurrenceRule`.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ChecklistItemBody {
  id: string;
  text: string;
  done: boolean;
  order: number;
}

interface RecurrenceRuleBody {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: number[];
  endDate?: string;
}

interface ObjectBody {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  checklist: ChecklistItemBody[];
  recurrenceRule?: RecurrenceRuleBody;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface RawChecklistRecurrenceRow {
  checklist: unknown;
  recurrence_rule: unknown;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `checklist-recurrence-projection-test-user-${String(emailCounter)}@example.com`;
}

/** The actor recorded on every event this file appends directly via `EventStoreService.append` (bypassing HTTP, which has no writer route for these event types yet -- that's PR6b). */
const DIRECT_APPEND_ACTOR: Actor = { type: 'system', id: 'checklist-recurrence-projection-test' };

describe('F1-T10 PR6a (RED step): objects_view checklist/recurrenceRule projection (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // Resolved from the SAME compiled module graph the running `app` uses
    // (not freshly constructed) -- `EventStoreModule` already exports both,
    // and `ObjectsService` already depends on them, so they are guaranteed
    // reachable here.
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
      .send({ name: `Checklist/recurrence projection test ${String(emailCounter)}` });

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

  async function createTask(
    cookie: string,
    workspaceId: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(objectsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
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

  /** `objectId -> streamId`, via the ALREADY-existing, unrelated-to-this-PR `streamId` column. */
  async function findStreamId(objectId: string): Promise<string> {
    const [row] = await rawDb
      .select({ streamId: objectsView.streamId })
      .from(objectsView)
      .where(eq(objectsView.id, objectId))
      .limit(1);

    if (!row) {
      throw new Error(`objects_view row not found for object ${objectId}`);
    }

    return row.streamId;
  }

  /**
   * Appends a single event directly to `streamId` via `EventStoreService`,
   * bypassing HTTP entirely (this PR adds no writer route for
   * checklist/recurrence-rule events -- that's PR6b). Reads the stream first
   * to compute the correct `expectedVersion`, mirroring
   * `ObjectsService.applyCommand`'s own `priorEvents.length` pattern.
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

  /** A FRESH `ObjectsViewProjection` instance is fine -- `ProjectionRunner.catchUp` checkpoints by `projection.name`, not instance identity (see that projection's own doc comment). */
  async function catchUpObjectsViewProjection(): Promise<void> {
    await projectionRunner.catchUp(new ObjectsViewProjection());
  }

  /**
   * Reads `checklist`/`recurrence_rule` straight off the `objects_view` row
   * via the raw `pg` driver (`rawDb.$client`), NOT via Drizzle's typed
   * `objectsView` schema object -- see this file's header comment for why.
   * Parameterized (`$1`), never string-concatenated.
   */
  async function readRawChecklistAndRecurrenceRule(
    objectId: string,
  ): Promise<{ checklist: unknown; recurrenceRule: unknown }> {
    const result = await rawDb.$client.query<RawChecklistRecurrenceRow>(
      'select checklist, recurrence_rule from objects_view where id = $1',
      [objectId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`objects_view row not found for object ${objectId}`);
    }

    return { checklist: row.checklist, recurrenceRule: row.recurrence_rule };
  }

  describe('AC1: checklist add/toggle/remove fold into the real `checklist` array returned by GET .../objects/:objectId', () => {
    it('addChecklistItem x3 + toggle + remove -- GET returns the correctly-folded 2-item checklist, not the hardcoded []', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Grocery run');
      const streamId = await findStreamId(task.id);

      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-milk',
        text: 'Buy milk',
        order: 0,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-eggs',
        text: 'Buy eggs',
        order: 1,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-bread',
        text: 'Buy bread',
        order: 2,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemToggled', {
        objectId: task.id,
        itemId: 'item-eggs',
        done: true,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemRemoved', {
        objectId: task.id,
        itemId: 'item-bread',
      });

      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, task.id);

      expect(object.checklist).toEqual([
        { id: 'item-milk', text: 'Buy milk', done: false, order: 0 },
        { id: 'item-eggs', text: 'Buy eggs', done: true, order: 1 },
      ]);
    });
  });

  describe('AC2: recurrenceRule set then cleared folds into `objects_view`', () => {
    it('RecurrenceRuleSet folds into `recurrenceRule`, and a subsequent RecurrenceRuleCleared resets it to undefined', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Weekly report');
      const streamId = await findStreamId(task.id);

      await appendEvent(streamId, workspaceId, 'RecurrenceRuleSet', {
        objectId: task.id,
        frequency: 'weekly',
        interval: 1,
        byWeekday: [1, 3, 5],
      });
      await catchUpObjectsViewProjection();

      const afterSet = await getObject(cookie, workspaceId, task.id);
      expect(afterSet.recurrenceRule).toEqual({
        frequency: 'weekly',
        interval: 1,
        byWeekday: [1, 3, 5],
      });

      await appendEvent(streamId, workspaceId, 'RecurrenceRuleCleared', { objectId: task.id });
      await catchUpObjectsViewProjection();

      const afterClear = await getObject(cookie, workspaceId, task.id);
      expect(afterClear.recurrenceRule).toBeUndefined();
    });
  });

  describe('AC3 regression: an interleaved FieldValueChanged write must not clobber checklist/recurrenceRule back to empty', () => {
    it('setting an ordinary custom field (`priority`) between checklist/recurrence-rule writes leaves both fully intact', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Interleaved writes task');
      const streamId = await findStreamId(task.id);

      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-a',
        text: 'Item A',
        order: 0,
      });
      await appendEvent(streamId, workspaceId, 'RecurrenceRuleSet', {
        objectId: task.id,
        frequency: 'daily',
        interval: 2,
      });
      // The regression under test: `FieldValueChanged`'s own projection
      // handler uses a targeted, single-key `jsonb_set` on `field_values`
      // (see `objects-view.projection.ts`) -- it must never touch the
      // separate `checklist`/`recurrence_rule` columns.
      await appendEvent(streamId, workspaceId, 'FieldValueChanged', {
        objectId: task.id,
        fieldKey: 'priority',
        value: 'high',
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-b',
        text: 'Item B',
        order: 1,
      });

      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, task.id);

      expect(object.fieldValues.priority).toBe('high');
      expect(object.checklist).toEqual([
        { id: 'item-a', text: 'Item A', done: false, order: 0 },
        { id: 'item-b', text: 'Item B', done: false, order: 1 },
      ]);
      expect(object.recurrenceRule).toEqual({ frequency: 'daily', interval: 2 });
    });
  });

  describe("AC4: ChecklistItemReordered updates both array order and each item's own `order` field", () => {
    it("the final checklist array order AND each item's `order` field match the reorder command's orderedItemIds", async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Reorder task');
      const streamId = await findStreamId(task.id);

      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-1',
        text: 'First',
        order: 0,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-2',
        text: 'Second',
        order: 1,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-3',
        text: 'Third',
        order: 2,
      });
      await appendEvent(streamId, workspaceId, 'ChecklistItemReordered', {
        objectId: task.id,
        orderedItemIds: ['item-3', 'item-1', 'item-2'],
      });

      await catchUpObjectsViewProjection();

      const object = await getObject(cookie, workspaceId, task.id);

      expect(object.checklist.map((item) => item.id)).toEqual(['item-3', 'item-1', 'item-2']);
      expect(object.checklist).toEqual([
        { id: 'item-3', text: 'Third', done: false, order: 0 },
        { id: 'item-1', text: 'First', done: false, order: 1 },
        { id: 'item-2', text: 'Second', done: false, order: 2 },
      ]);
    });
  });

  describe('raw `objects_view` row (bypassing ObjectsService/HTTP entirely)', () => {
    it('the persisted `checklist`/`recurrence_rule` columns carry the same folded state the HTTP GET response returns', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      const task = await createTask(cookie, workspaceId, 'Raw row check task');
      const streamId = await findStreamId(task.id);

      await appendEvent(streamId, workspaceId, 'ChecklistItemAdded', {
        objectId: task.id,
        itemId: 'item-only',
        text: 'Only item',
        order: 0,
      });
      await appendEvent(streamId, workspaceId, 'RecurrenceRuleSet', {
        objectId: task.id,
        frequency: 'monthly',
        interval: 1,
      });

      await catchUpObjectsViewProjection();

      // Read via the standard HTTP path too, for a same-test cross-check
      // once this all turns GREEN.
      const object = await getObject(cookie, workspaceId, task.id);

      const { checklist, recurrenceRule } = await readRawChecklistAndRecurrenceRule(task.id);

      expect(checklist).toEqual([{ id: 'item-only', text: 'Only item', done: false, order: 0 }]);
      expect(recurrenceRule).toEqual({ frequency: 'monthly', interval: 1 });
      expect(checklist).toEqual(object.checklist);
      expect(recurrenceRule).toEqual(object.recurrenceRule);
    });
  });
});
