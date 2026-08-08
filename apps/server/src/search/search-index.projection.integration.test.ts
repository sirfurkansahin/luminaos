import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { searchIndex } from '../db/schema/search-index.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { SearchIndexProjection } from '../search/search-index.projection.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T13 PR3a (RED step) — ADR-0013 §(d) "search_index projeksiyonu +
 * tablosu". TITLE-ONLY slice: `ObjectCreated`/`ObjectRenamed` folded into
 * `search_index.tsv` via `to_tsvector('simple', ...)`. A follow-up PR3b adds
 * `DocumentContentSnapshotted` (Yjs-decoded doc text) — deliberately NOT
 * tested here.
 *
 * Mirrors `docs/document-snapshots-projection.integration.test.ts`'s
 * Testcontainers harness EXACTLY (same `postgres:16` + `redis:7`, same
 * DATABASE_URL/REDIS_URL env vars, same dynamic `import('../app.module.js')`
 * after env is set, same `EventStoreService`/`ProjectionRunner` resolution
 * via `app.get(...)`, same "read stream for expectedVersion, then append"
 * helper).
 *
 * NEITHER `../search/search-index.projection.js` NOR
 * `../db/schema/search-index.js` exists yet, so every `it` fails at IMPORT
 * time (module not found) — the correct red state.
 *
 * ============================================================================
 * DESIGNED CONTRACT the implementer must match precisely:
 *
 *   // ../search/search-index.projection.ts
 *   class SearchIndexProjection implements Projection {
 *     name = 'search-index';
 *     handles = ['ObjectCreated', 'ObjectRenamed'];
 *     // PR3b will add 'DocumentContentSnapshotted' later — do NOT test for
 *     // it in this file.
 *     //
 *     // apply(event, tx):
 *     //   'ObjectCreated': INSERT one row —
 *     //     object_id = payload.objectId, workspace_id = event.workspaceId,
 *     //     title = payload.title, doc_text = NULL,
 *     //     tsv = to_tsvector('simple', title), embedding = NULL,
 *     //     updated_at = event.occurredAt.
 *     //     A missing/non-string `title` payload field must THROW (mirrors
 *     //     `objects-view.projection.ts`'s `InvalidObjectStateError`
 *     //     discipline for the identical event type) rather than insert a
 *     //     row with a bad/placeholder title.
 *     //   'ObjectRenamed': UPDATE the existing row (object_id =
 *     //     payload.objectId) —
 *     //     title = payload.title,
 *     //     tsv = to_tsvector('simple', title || ' ' || coalesce(doc_text, '')),
 *     //     updated_at = event.occurredAt. (doc_text stays whatever it
 *     //     already was — NULL in this PR's scope since nothing writes it
 *     //     yet.)
 *     // reset(tx): DELETE all rows from search_index.
 *   }
 *
 *   // `search_index` table (ADR-0013 §d): object_id varchar(26) PRIMARY KEY,
 *   //   workspace_id uuid NOT NULL, title text NOT NULL, doc_text text
 *   //   (nullable), tsv tsvector NOT NULL, embedding real[] (nullable),
 *   //   updated_at timestamptz NOT NULL. A GIN index on `tsv` (not asserted
 *   //   directly here — only that queries against `tsv` behave correctly).
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `search-index-projection-test-user-${String(emailCounter)}@example.com`;
}

let objectCounter = 0;

/** Distinct ULID-shaped (26-char Crockford base32) object ids, one per test. */
function freshObjectId(): string {
  objectCounter += 1;
  return `01ARZ3NDEKTSV4RRFFQ69G${String(objectCounter).padStart(4, '0')}`;
}

/** The actor recorded on every event this file appends directly (bypassing HTTP — no writer route exists for these raw event shapes). */
const DIRECT_APPEND_ACTOR: Actor = { type: 'system', id: 'search-index-projection-test' };

describe('F1-T13 PR3a (RED step): search_index title-only projection (real Postgres, via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let projection: SearchIndexProjection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the established
    // convention in every other integration test file here.
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
    projection = new SearchIndexProjection();
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
      .send({ name: `Search index projection test ${String(emailCounter)}` });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function freshWorkspaceId(): Promise<string> {
    const cookie = await registerUser();
    return createWorkspace(cookie);
  }

  /**
   * Appends one event directly to `streamId` via `EventStoreService`, reading
   * the stream first to compute the correct `expectedVersion` (mirrors the
   * `document-snapshots-projection.integration.test.ts` harness).
   */
  async function appendEvent(
    streamId: string,
    workspaceId: string,
    type: string,
    payload: Record<string, unknown>,
    occurredAt: Date = new Date(),
  ): Promise<number> {
    const priorEvents = await eventStore.readStream(streamId);
    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: 'lumina-object',
      workspaceId,
      type,
      payload,
      actor: DIRECT_APPEND_ACTOR,
      occurredAt,
    };

    const [stored] = await eventStore.append(streamId, priorEvents.length, [event]);
    if (!stored) {
      throw new Error(`append returned no stored event for stream ${streamId}`);
    }
    return stored.version;
  }

  /**
   * Creates a fresh object stream: a random UUID `streamId` whose first event
   * (version 1) is `ObjectCreated { objectType, title }`. Returns the ULID
   * `objectId` (== the object's own id) and the `streamId`.
   */
  async function createObjectStream(
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<{ objectId: string; streamId: string }> {
    const objectId = freshObjectId();
    const streamId = crypto.randomUUID();
    await appendEvent(streamId, workspaceId, 'ObjectCreated', {
      objectId,
      objectType,
      title,
    });
    return { objectId, streamId };
  }

  interface SearchIndexRow {
    objectId: string;
    workspaceId: string;
    title: string;
    docText: string | null;
    embedding: number[] | null;
  }

  async function getRow(objectId: string): Promise<SearchIndexRow | undefined> {
    const [row] = await rawDb
      .select({
        objectId: searchIndex.objectId,
        workspaceId: searchIndex.workspaceId,
        title: searchIndex.title,
        docText: searchIndex.docText,
        embedding: searchIndex.embedding,
      })
      .from(searchIndex)
      .where(eq(searchIndex.objectId, objectId))
      .limit(1);

    return row;
  }

  async function countRows(objectId: string): Promise<number> {
    const result = await rawDb.$client.query<{ count: string }>(
      'select count(*)::text as count from search_index where object_id = $1',
      [objectId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /** Object ids whose `search_index.tsv` matches `query` (plain-text, 'simple' config). */
  async function matchingObjectIds(query: string): Promise<string[]> {
    const result = await rawDb.$client.query<{ object_id: string }>(
      "select object_id from search_index where tsv @@ plainto_tsquery('simple', $1)",
      [query],
    );
    return result.rows.map((row) => row.object_id);
  }

  describe('AC1: ObjectCreated inserts a row with a working tsvector', () => {
    it('row exists with matching title/workspace, null doc_text/embedding, and the tsvector matches its own words but not an unrelated word', async () => {
      const workspaceId = await freshWorkspaceId();
      const { objectId } = await createObjectStream(workspaceId, 'doc', 'Quarterly Planning Doc');

      await projectionRunner.catchUp(projection);

      const row = await getRow(objectId);
      expect(row).toBeDefined();
      expect(row?.title).toBe('Quarterly Planning Doc');
      expect(row?.workspaceId).toBe(workspaceId);
      expect(row?.docText).toBeNull();
      expect(row?.embedding).toBeNull();

      const matches = await matchingObjectIds('Quarterly Planning');
      expect(matches).toContain(objectId);

      const unrelatedMatches = await matchingObjectIds('xylophone');
      expect(unrelatedMatches).not.toContain(objectId);
    });
  });

  describe('AC2: ObjectRenamed updates the row and recomputes the tsvector for the NEW title only', () => {
    it('title is updated, new title matches, old title no longer matches', async () => {
      const workspaceId = await freshWorkspaceId();
      const { objectId, streamId } = await createObjectStream(
        workspaceId,
        'doc',
        'Old Title Alpha',
      );

      await projectionRunner.catchUp(projection);

      await appendEvent(streamId, workspaceId, 'ObjectRenamed', {
        objectId,
        title: 'New Title Beta',
      });

      await projectionRunner.catchUp(projection);

      const row = await getRow(objectId);
      expect(row?.title).toBe('New Title Beta');

      const newMatches = await matchingObjectIds('Beta');
      expect(newMatches).toContain(objectId);

      const oldMatches = await matchingObjectIds('Alpha');
      expect(oldMatches).not.toContain(objectId);
    });
  });

  describe('AC3: workspace_id is scoped from the event envelope, not guessable/defaulted', () => {
    it('two objects created in two different workspaces each get their OWN workspace_id, never the other', async () => {
      const workspaceOne = await freshWorkspaceId();
      const workspaceTwo = await freshWorkspaceId();
      expect(workspaceOne).not.toBe(workspaceTwo);

      const { objectId: objectOneId } = await createObjectStream(
        workspaceOne,
        'doc',
        'Workspace One Object',
      );
      const { objectId: objectTwoId } = await createObjectStream(
        workspaceTwo,
        'doc',
        'Workspace Two Object',
      );

      await projectionRunner.catchUp(projection);

      const rowOne = await getRow(objectOneId);
      const rowTwo = await getRow(objectTwoId);

      expect(rowOne?.workspaceId).toBe(workspaceOne);
      expect(rowOne?.workspaceId).not.toBe(workspaceTwo);
      expect(rowTwo?.workspaceId).toBe(workspaceTwo);
      expect(rowTwo?.workspaceId).not.toBe(workspaceOne);
    });
  });

  describe('AC4: rebuild (reset + full replay) reproduces the same result as incremental catch-up', () => {
    it('after a full rebuild, the row has the same title and is still tsv-queryable', async () => {
      const workspaceId = await freshWorkspaceId();
      const { objectId } = await createObjectStream(workspaceId, 'doc', 'Rebuild Determinism Doc');

      await projectionRunner.catchUp(projection);
      expect(await countRows(objectId)).toBe(1);

      // `ProjectionRunner.rebuild` is the documented one-call entry point:
      // truncates the projection's own state + resets its checkpoint to 0,
      // then replays the ENTIRE event log from the start.
      await expect(projectionRunner.rebuild(projection)).resolves.toBeUndefined();

      expect(await countRows(objectId)).toBe(1);

      const row = await getRow(objectId);
      expect(row?.title).toBe('Rebuild Determinism Doc');

      const matches = await matchingObjectIds('Rebuild Determinism');
      expect(matches).toContain(objectId);
    });
  });

  describe('AC5: a malformed/missing title on ObjectCreated throws rather than silently inserting a bad row', () => {
    it('catchUp rejects when the event payload has no valid string title, and no row is inserted', async () => {
      const workspaceId = await freshWorkspaceId();
      const objectId = freshObjectId();
      const streamId = crypto.randomUUID();

      // Malformed event appended directly via the raw event store, bypassing
      // normal command validation — simulates a corrupted/legacy event.
      await appendEvent(streamId, workspaceId, 'ObjectCreated', {
        objectId,
        objectType: 'doc',
        // `title` deliberately omitted (also not a string).
      });

      await expect(projectionRunner.catchUp(projection)).rejects.toBeTruthy();

      expect(await countRows(objectId)).toBe(0);
    });
  });

  describe('SearchIndexProjection static contract', () => {
    it('name === "search-index" and handles === ["ObjectCreated", "ObjectRenamed"]', () => {
      expect(projection.name).toBe('search-index');
      expect(projection.handles).toEqual(['ObjectCreated', 'ObjectRenamed']);
    });
  });
});
