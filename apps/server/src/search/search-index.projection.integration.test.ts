import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { Actor, NewDomainEvent, ProjectionTx } from '@luminaos/shared';

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
 *
 * F1-T13 PR3b (RED step) — ADR-0013 §(d) follow-up. Extends the SAME
 * `SearchIndexProjection` with `'DocumentContentSnapshotted'` handling:
 *
 *   // 'DocumentContentSnapshotted' (payload: { docId, snapshot: base64, version }):
 *   //   parse with documentContentSnapshottedPayloadSchema, decode base64 ->
 *   //   Buffer, run extractPlainTextFromYjsUpdate(buffer) -> docText, then
 *   //   UPDATE the existing search_index row (object_id = payload.docId):
 *   //   doc_text = docText,
 *   //   tsv = to_tsvector('simple', coalesce(title,'') || ' ' || docText),
 *   //   updated_at = event.occurredAt.
 *   //   If no existing row is found (0 rows affected — an orphan snapshot
 *   //   with no prior ObjectCreated), throw InvalidObjectStateError (mirrors
 *   //   PR3a's defensive discipline; this should never happen in practice
 *   //   since ObjectCreated always precedes any doc snapshot on the same
 *   //   object stream, but must fail loudly rather than silently no-op).
 *
 * `extractPlainTextFromYjsUpdate` (F1-T13 PR3b, `../docs/yjs-plain-text.ts`)
 * decodes a Yjs full-state update and recursively walks BlockNote's
 * `'document-store'` `Y.XmlFragment` (the exact fragment key, confirmed in
 * `apps/web/src/views/doc/DocEditor.tsx`) to a flat plain-text string,
 * descending into nested `Y.XmlElement` children at any depth (toggle-heading/
 * nested-list child blocks). These new tests construct snapshot fixtures with
 * raw Yjs APIs (`new Y.Doc()`, `doc.getXmlFragment('document-store')`,
 * `Y.XmlElement`/`Y.XmlText`, `Y.encodeStateAsUpdate`, base64-encode) — the
 * mirror image of `doc-collab.gateway.ts`'s own encode side (around line 692:
 * `Y.encodeStateAsUpdate(room.doc)` -> `Buffer.from(update).toString('base64')`).
 *
 * NEITHER `../docs/yjs-plain-text.js` exists yet NOR does
 * `SearchIndexProjection.handles` include `'DocumentContentSnapshotted'`, so
 * every new `it` below fails — module-not-found (once `yjs-plain-text.ts` is
 * imported by the projection/test) or an assertion failure against the
 * unchanged `'ObjectCreated'`/`'ObjectRenamed'`-only projection — the correct
 * RED state.
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

  /**
   * Builds a `DocumentContentSnapshotted` event payload (F1-T13 PR3b) whose
   * `snapshot` is a base64-encoded Yjs full-state update, with `text` inserted
   * as a flat `Y.XmlText` directly under the `'document-store'` fragment — the
   * EXACT key `apps/web/src/views/doc/DocEditor.tsx` reads/writes (a wrong key
   * would silently produce an empty fragment, no error).
   */
  function buildDocSnapshotPayload(
    docId: string,
    version: number,
    text: string,
  ): { docId: string; snapshot: string; version: number } {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('document-store');
    fragment.insert(0, [new Y.XmlText(text)]);
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    return { docId, snapshot, version };
  }

  /**
   * Builds a `DocumentContentSnapshotted` payload whose fragment has a
   * top-level `Y.XmlElement('heading')` with its own `Y.XmlText`, AND a
   * NESTED child `Y.XmlElement('paragraph')` (simulating a toggle-heading's
   * collapsed child block) with its OWN `Y.XmlText` — the same 2-level
   * construction as the Part A unit tests
   * (`apps/server/src/docs/yjs-plain-text.test.ts`), proven here through the
   * full projection.
   */
  function buildNestedDocSnapshotPayload(
    docId: string,
    version: number,
    headingText: string,
    nestedChildText: string,
  ): { docId: string; snapshot: string; version: number } {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('document-store');

    const nestedChild = new Y.XmlElement('paragraph');
    nestedChild.insert(0, [new Y.XmlText(nestedChildText)]);

    const heading = new Y.XmlElement('heading');
    heading.insert(0, [new Y.XmlText(headingText), nestedChild]);

    fragment.insert(0, [heading]);

    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    return { docId, snapshot, version };
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

  describe('AC6 (PR3b): DocumentContentSnapshotted makes doc content searchable and combines with title', () => {
    it('doc_text/tsv reflect the decoded snapshot text, and both title and doc content match tsv queries', async () => {
      const workspaceId = await freshWorkspaceId();
      const { objectId, streamId } = await createObjectStream(workspaceId, 'doc', 'Meeting Notes');

      await projectionRunner.catchUp(projection);

      const payload = buildDocSnapshotPayload(objectId, 1, 'roadmap discussion');
      await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', payload);

      await projectionRunner.catchUp(projection);

      const row = await getRow(objectId);
      expect(row?.docText).toContain('roadmap discussion');

      const titleMatches = await matchingObjectIds('Meeting');
      expect(titleMatches).toContain(objectId);

      const docMatches = await matchingObjectIds('roadmap');
      expect(docMatches).toContain(objectId);

      const unrelatedMatches = await matchingObjectIds('xylophone');
      expect(unrelatedMatches).not.toContain(objectId);
    });
  });

  describe('AC7 (PR3b): nested/toggle-heading content in a real doc snapshot is searchable through the full projection', () => {
    it('a word that exists ONLY in the nested child text still matches the tsv query', async () => {
      const workspaceId = await freshWorkspaceId();
      const { objectId, streamId } = await createObjectStream(
        workspaceId,
        'doc',
        'Toggle Heading Doc',
      );

      await projectionRunner.catchUp(projection);

      const payload = buildNestedDocSnapshotPayload(
        objectId,
        1,
        'visible heading text',
        'collapsedchildonlyword',
      );
      await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', payload);

      await projectionRunner.catchUp(projection);

      const nestedMatches = await matchingObjectIds('collapsedchildonlyword');
      expect(nestedMatches).toContain(objectId);

      const headingMatches = await matchingObjectIds('visible');
      expect(headingMatches).toContain(objectId);
    });
  });

  describe('AC8 (PR3b): re-snapshotting REPLACES (not accumulates) doc_text/tsv', () => {
    it('after a second snapshot, only the new text matches; the old text no longer does; title is unaffected', async () => {
      const workspaceId = await freshWorkspaceId();
      const { objectId, streamId } = await createObjectStream(workspaceId, 'doc', 'Meeting Notes');

      await projectionRunner.catchUp(projection);

      const firstPayload = buildDocSnapshotPayload(objectId, 1, 'roadmap discussion');
      await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', firstPayload);
      await projectionRunner.catchUp(projection);

      const secondPayload = buildDocSnapshotPayload(objectId, 2, 'quarterly budget review');
      await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', secondPayload);
      await projectionRunner.catchUp(projection);

      const row = await getRow(objectId);
      expect(row?.docText).toContain('quarterly budget review');
      expect(row?.docText).not.toContain('roadmap');

      const oldMatches = await matchingObjectIds('roadmap');
      expect(oldMatches).not.toContain(objectId);

      const newMatches = await matchingObjectIds('budget');
      expect(newMatches).toContain(objectId);

      const titleMatches = await matchingObjectIds('Meeting');
      expect(titleMatches).toContain(objectId);
    });
  });

  describe('AC9 (PR3b): an orphan DocumentContentSnapshotted (no prior ObjectCreated row) throws', () => {
    it('projection.apply() rejects when the search_index row does not exist yet for the snapshot’s docId, in isolation from the shared catchUp checkpoint', async () => {
      // Deliberately bypasses `projectionRunner.catchUp` (and thus never
      // touches this file's SHARED, permanently-advancing checkpoint):
      // `ProjectionRunner.catchUp` processes the GLOBAL event log in one
      // batch/transaction per projection, keyed by `projection.name` — once
      // ANY event is rejected, the checkpoint can never advance past it, and
      // every LATER `catchUp` call (even after a full `rebuild`, since
      // `rebuild` replays the ENTIRE log from position 0) would re-encounter
      // the same poison event first and reject for THAT reason instead of
      // whatever this test is actually trying to prove. Only ONE such
      // "expect catchUp to reject" test can safely exist per shared-instance
      // file (see AC5, deliberately kept last for the same reason) — so this
      // test instead calls `projection.apply()` directly inside its own
      // `rawDb.transaction`, which Drizzle automatically rolls back when the
      // callback throws. This fully isolates the assertion from the shared
      // checkpoint and lets AC9 run safely BEFORE AC5.
      const workspaceId = await freshWorkspaceId();
      const objectId = freshObjectId();
      const streamId = crypto.randomUUID();

      // Directly appends `DocumentContentSnapshotted` as the FIRST event on
      // this stream, bypassing normal object creation — simulates
      // corrupt/out-of-order data (no corresponding search_index row exists).
      const payload = buildDocSnapshotPayload(objectId, 1, 'orphaned snapshot text');
      await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', payload);

      const [event] = (await eventStore.readStream(streamId)).slice(-1);
      if (!event) {
        throw new Error(`no event found on stream ${streamId} after appending`);
      }

      let caught: unknown;
      try {
        await rawDb.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
      expect(await countRows(objectId)).toBe(0);
    });
  });

  describe('AC5: a malformed/missing title on ObjectCreated throws rather than silently inserting a bad row', () => {
    it('catchUp rejects when the event payload has no valid string title, and no row is inserted', async () => {
      // Kept LAST (after every other catchUp-based test, including AC9's
      // isolated apply() test above) — see AC9's comment for why: once this
      // event is rejected, `ProjectionRunner.catchUp`'s shared checkpoint can
      // never advance past it again for the rest of this file.
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
    it('name === "search-index" and handles === ["ObjectCreated", "ObjectRenamed", "DocumentContentSnapshotted"]', () => {
      expect(projection.name).toBe('search-index');
      expect(projection.handles).toEqual([
        'ObjectCreated',
        'ObjectRenamed',
        'DocumentContentSnapshotted',
      ]);
    });
  });
});
