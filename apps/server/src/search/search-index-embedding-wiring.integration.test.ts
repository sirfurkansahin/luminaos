import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { EMBEDDING_DIMENSIONS } from '@luminaos/ai-gateway';

import { SessionService } from '../auth/session.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { searchIndex } from '../db/schema/search-index.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * F1-T13 PR4 (RED step) — ADR-0013 §(e) WIRING verification: end-to-end proof
 * that a title change (via the ordinary object-rename route) and a doc
 * content snapshot (via the real `DocCollabGateway` WebSocket) each actually
 * SCHEDULE and (after a short real wait past the debounce) PRODUCE a non-null
 * `search_index.embedding` -- not just that the underlying pieces work in
 * isolation (that's `./search-index-embedding-refresh.integration.test.ts`'s
 * job) or that the scheduler debounces correctly on its own (that's
 * `./search-index-embedding-scheduler.service.test.ts`'s job).
 *
 * Mirrors `../objects/object-ai-refresh.integration.test.ts`'s own
 * "make the debounce window testable" technique EXACTLY (see that file's
 * header doc comment, design decision 3): set a NEW env var
 * (`SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS`) to a short value BEFORE the dynamic
 * `import('../app.module.js')`, then wait a short REAL wall-clock delay
 * (comfortably longer than the debounce) rather than reaching into Nest's DI
 * container for the scheduler instance directly.
 *
 * `DOC_SNAPSHOT_DEBOUNCE_MS` is ALSO set short here (unlike
 * `doc-collab-persistence.integration.test.ts`, which deliberately sets it
 * LONG to force only the graceful-flush path) so AC2 below can observe an
 * automatic, debounce-triggered snapshot without needing to close the app.
 *
 * ============================================================================
 * BUG FIX THIS FILE VERIFIES (AC2): before this PR, `doc-collab.gateway.ts`'s
 * `snapshotRoom` appended `DocumentContentSnapshotted` and caught up
 * `DocumentSnapshotsProjection`, but NEVER caught up `SearchIndexProjection`
 * -- so in production, `search_index.doc_text`/`tsv` for a doc's content never
 * actually updated after a snapshot, except as an accidental side-effect of
 * some UNRELATED object write elsewhere happening to catch it up later. This
 * file proves BOTH halves of the fix: (a) `search_index.doc_text` reflects the
 * snapshotted content, and (b) an embedding refresh is scheduled off the SAME
 * code path and eventually lands a non-null `embedding`.
 *
 * Nothing under test here exists yet:
 *   - `../config/env.ts` does not read `SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS`
 *     (`../config/env-search.test.ts` pins that contract separately).
 *   - `./search-index-embedding-scheduler.service.ts` does not exist.
 *   - `./search-index-embedding-refresh.service.ts` does not exist.
 *   - `../ai/embedding-provider.token.ts` / `../ai/embedding-provider.module.ts`
 *     do not exist.
 *   - Nothing calls `.schedule(objectId, ...)` from `ObjectsService`'s
 *     title-changing call sites, nor from `DocCollabGateway.snapshotRoom`.
 *   - `DocCollabGateway.snapshotRoom` does not call
 *     `this.projectionRunner.catchUp(this.searchIndexProjection)` at all (the
 *     wiring gap AC2 exists to close).
 * `implementer` must build all of the above; every test below is expected to
 * fail (red) until then.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

// y-websocket message framing constants (must match the gateway).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `search-index-embedding-wiring-test-user-${String(emailCounter)}@example.com`;
}

interface UserEnvelope {
  user: { id: string; email: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}
interface ObjectEnvelope {
  object: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Event-driven poll (NOT a fixed sleep) for a convergence check against the DB. */
async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`waitForAsync: condition not met within ${String(timeoutMs)}ms`);
}

/** Normalizes any `ws` binary payload to a `Uint8Array` for lib0 decoding. */
function toBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

interface YDocClient {
  ws: WebSocket;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  whenSynced: Promise<void>;
}

const openSockets: WebSocket[] = [];

/** Minimal Yjs WS client — mirrors `doc-collab-persistence.integration.test.ts`'s own client verbatim. */
function connectYDocClient(port: number, params: { docId?: string; sid?: string }): YDocClient {
  const { docId, sid } = params;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  const query: string[] = [];
  if (docId !== undefined) {
    query.push(`docId=${docId}`);
  }
  const url = `ws://127.0.0.1:${String(port)}/ws/docs?${query.join('&')}`;

  const ws = new WebSocket(url, {
    headers: sid !== undefined ? { Cookie: `sid=${sid}` } : {},
  });
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  let resolveSynced: () => void = () => undefined;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });

  const send = (payload: Uint8Array): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  };

  ws.on('open', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(encoding.toUint8Array(encoder));
  });

  ws.on('message', (data: RawData) => {
    const decoder = decoding.createDecoder(toBytes(data));
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      if (encoding.length(encoder) > 1) {
        send(encoding.toUint8Array(encoder));
      }
      if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
        resolveSynced();
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), ws);
    }
  });

  doc.on('update', (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === ws) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });

  ws.on('error', () => undefined);

  return { ws, doc, awareness, whenSynced };
}

describe('F1-T13 PR4 (RED step): search-index embedding refresh WIRING (real Postgres + Redis + HTTP + ws via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let port: number;
  let rawDb: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // DETERMINISM: set BEFORE importing app.module (env is read once at boot).
    // Short enough to assert against with a short real wait, per this file's
    // header doc comment.
    process.env.SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS = '50';
    process.env.DOC_SNAPSHOT_DEBOUNCE_MS = '50';

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    port = address.port;
    rawDb = createDatabaseClient(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    for (const socket of openSockets) {
      try {
        socket.terminate();
      } catch {
        // best-effort cleanup
      }
    }
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
  }

  async function createWorkspace(cookie: string): Promise<string> {
    const response = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Search index embedding wiring test ${String(emailCounter)}` });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function createObject(
    cookie: string,
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType, title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  async function renameObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
    title: string,
  ): Promise<void> {
    const response = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie)
      .send({ title });

    expect(response.status).toBe(200);
  }

  async function getSearchIndexRow(
    objectId: string,
  ): Promise<{ docText: string | null; embedding: number[] | null } | undefined> {
    const [row] = await rawDb
      .select({ docText: searchIndex.docText, embedding: searchIndex.embedding })
      .from(searchIndex)
      .where(eq(searchIndex.objectId, objectId))
      .limit(1);

    return row;
  }

  describe('AC1: renaming an object schedules an embedding refresh that lands after the debounce window', () => {
    it('search_index.embedding is non-null with length EMBEDDING_DIMENSIONS after a short wait past SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS', async () => {
      const { cookie } = await registerUser();
      const workspaceId = await createWorkspace(cookie);
      const objectId = await createObject(cookie, workspaceId, 'task', 'Original Title');

      await renameObject(cookie, workspaceId, objectId, 'Renamed Title For Embedding');

      // Comfortably longer than the 50ms debounce set in beforeAll.
      await waitForAsync(async () => {
        const row = await getSearchIndexRow(objectId);
        return row?.embedding !== null && row?.embedding !== undefined;
      }, 5_000);

      const row = await getSearchIndexRow(objectId);
      expect(row?.embedding).not.toBeNull();
      expect(row?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    });
  });

  describe('AC2 (bug-fix verification): a DocumentContentSnapshotted event updates search_index doc_text/tsv AND schedules an embedding refresh', () => {
    it('after a real WebSocket edit + automatic snapshot debounce, search_index.doc_text reflects the edit and search_index.embedding eventually becomes non-null', async () => {
      const { cookie, userId } = await registerUser();
      const workspaceId = await createWorkspace(cookie);
      const docId = await createObject(cookie, workspaceId, 'doc', 'Wiring Test Doc');

      const session = await app.get(SessionService).createSession(userId);
      const sid = session.id;

      const client = connectYDocClient(port, { docId, sid });
      await client.whenSynced;

      // Must write into the SAME `'document-store'` `Y.XmlFragment` BlockNote
      // itself reads/writes (confirmed in `apps/web/src/views/doc/DocEditor.tsx`
      // and used by `extractPlainTextFromYjsUpdate`,
      // `apps/server/src/docs/yjs-plain-text.ts`) — a generic `'body'` `Y.Text`
      // (as `doc-collab-persistence.integration.test.ts` uses for its own,
      // unrelated generic-sync assertions) is never read by the decoder, so
      // `doc_text` would stay empty regardless of implementation correctness.
      client.doc
        .getXmlFragment('document-store')
        .insert(0, [new Y.XmlText('embedding wiring verification text')]);

      // The gateway's own DOC_SNAPSHOT_DEBOUNCE_MS (50ms, set in beforeAll)
      // should trigger an automatic snapshot without needing to close the app.
      await waitForAsync(async () => {
        const row = await getSearchIndexRow(docId);
        return typeof row?.docText === 'string' && row.docText.includes('embedding wiring');
      }, 5_000);

      // A second, independent debounce window (SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS)
      // must ALSO have been scheduled off the same snapshot code path.
      await waitForAsync(async () => {
        const row = await getSearchIndexRow(docId);
        return row?.embedding !== null && row?.embedding !== undefined;
      }, 5_000);

      const row = await getSearchIndexRow(docId);
      expect(row?.docText).toContain('embedding wiring');
      expect(row?.embedding).not.toBeNull();
      expect(row?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    });
  });
});
