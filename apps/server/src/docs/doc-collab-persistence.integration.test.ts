import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { SessionService } from '../auth/session.service.js';
import { runMigrations } from '../db/migrate.js';
import { DocumentReconstructionService } from '../docs/document-reconstruction.service.js';
import { EventStoreService } from '../event-store/event-store.service.js';

import type { AppModule as AppModuleType } from '../app.module.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * F1-T11 PR4b (RED step) — durable snapshot PERSISTENCE + lifecycle for the
 * `DocCollabGateway` built in PR4a.
 *
 * PR4a relays edits and LOADS the latest snapshot on join, but NEVER writes
 * snapshots, emits no audit event, and has no DoS caps. PR4b adds the write
 * side and the lifecycle guarantees this file pins:
 *
 *   - DEBOUNCED server-side snapshot writing: on client doc updates, after
 *     `DOC_SNAPSHOT_DEBOUNCE_MS` idle OR `DOC_SNAPSHOT_MAX_UPDATES` accumulated
 *     updates, the gateway encodes `Y.encodeStateAsUpdate(room.doc)` -> base64,
 *     validates it with `documentContentSnapshottedPayloadSchema` at APPEND time
 *     (reject oversized BEFORE writing — a HIGH security control), appends a
 *     `DocumentContentSnapshotted` event to the doc's OWN object event stream,
 *     then runs the snapshot projection so `document_snapshots` gets the row.
 *     Optimistic-concurrency safe (retry on `VersionConflictError`).
 *   - Per-session `DocumentEdited` AUDIT event: appended ONCE per (room,
 *     actorId) — the first time a given user edits in a room's lifetime —
 *     carrying `{ docId, actorId, at }` (never any content).
 *   - GRACEFUL SIGTERM flush: `onModuleDestroy` (async) synchronously snapshots
 *     every dirty room before shutdown, so a PLANNED restart is LOSSLESS. A
 *     CRASH (no `onModuleDestroy`) loses only the un-flushed window — the
 *     deliberate bounded-loss trade-off from ADR-0011 §(c).
 *   - `getLatestSnapshot(objectId, workspaceId?)` gains an optional
 *     workspaceId-scoping predicate (defense in depth); the gateway passes the
 *     resolved workspaceId.
 *   - DoS caps: `DOC_MAX_CONNECTIONS_PER_ROOM`, `DOC_MAX_ROOMS`, and a
 *     `maxPayload` frame cap on the `WebSocketServer`.
 *
 * ============================================================================
 * DETERMINISM STRATEGY (critical — removes all timing flakiness):
 *
 *   `beforeAll` sets a LONG `DOC_SNAPSHOT_DEBOUNCE_MS` and a HIGH
 *   `DOC_SNAPSHOT_MAX_UPDATES` BEFORE the dynamic `import('../app.module.js')`
 *   (env is read once at boot from `process.env`), so NO automatic debounced/
 *   count-triggered snapshot ever fires mid-test. Snapshots therefore happen
 *   ONLY via the graceful flush (`app.close()` -> `onModuleDestroy`).
 *   `app.close()` invokes Nest lifecycle hooks directly, so it exercises the
 *   flush path WITHOUT needing an OS signal. The "crash" case simply never
 *   calls `close()` on its app before asserting.
 *
 *   Graceful (lossless) vs crash (bounded-loss) need SEPARATE app lifecycles,
 *   so apps are started PER TEST (`startApp()`), all against the ONE shared
 *   Testcontainers Postgres/Redis from `beforeAll`. Users/workspaces/docs are
 *   seeded once over HTTP through a long-lived `harnessApp`, which also serves
 *   as a fresh reader (its `DocumentReconstructionService` /
 *   `EventStoreService` read the shared, durable store — equivalent to a fresh
 *   process reading what survived a restart/crash).
 *
 * ----------------------------------------------------------------------------
 * RED STATE (expected, today): PR4a's gateway writes NO snapshots, emits NO
 * `DocumentEdited`, and enforces NO connection cap. So:
 *   (1) graceful flush leaves `getLatestSnapshot` null — FAIL;
 *   (2) crash-window assertion never has a baseline to survive — FAIL;
 *   (3) zero `DocumentEdited` events land — FAIL (expected exactly 1);
 *   (4) the 3rd connection is ACCEPTED (no cap) so `whenUpgradeRejected`
 *       rejects instead of yielding 503 — FAIL.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

// y-websocket message framing constants (must match the gateway + PR4a client).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `doc-collab-persistence-test-user-${String(emailCounter)}@example.com`;
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

// All clients opened during the run, terminated in `afterAll` so vitest exits.
const openSockets: WebSocket[] = [];

/** Builds the `ws` connection headers from the optional `sid`/`origin`. */
function buildHeaders(sid?: string, origin?: string): Record<string, string> {
  return {
    ...(sid !== undefined ? { Cookie: `sid=${sid}` } : {}),
    ...(origin !== undefined ? { Origin: origin } : {}),
  };
}

/**
 * Minimal Yjs WS client — copied verbatim from PR4a's
 * `doc-collab-gateway.integration.test.ts` (do NOT modify that file). syncStep1
 * on open, `readSyncMessage` on each sync frame, local `doc` updates pushed back
 * to the server; `whenSynced` resolves once the first syncStep2 is processed.
 */
function connectYDocClient(
  port: number,
  params: { docId?: string; sid?: string; origin?: string },
): YDocClient {
  const { docId, sid, origin } = params;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  const query: string[] = [];
  if (docId !== undefined) {
    query.push(`docId=${docId}`);
  }
  const url = `ws://127.0.0.1:${String(port)}/ws/docs?${query.join('&')}`;

  const ws = new WebSocket(url, { headers: buildHeaders(sid, origin) });
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

/**
 * Opens a raw upgrade attempt and resolves with the HTTP status the server
 * writes when it REJECTS the upgrade (`'unexpected-response'`). REJECTS the
 * promise if the socket unexpectedly opens instead — copied from PR4a.
 */
function whenUpgradeRejected(
  port: number,
  params: { docId?: string; sid?: string; origin?: string },
): Promise<number | undefined> {
  const { docId, sid, origin } = params;
  const query: string[] = [];
  if (docId !== undefined) {
    query.push(`docId=${docId}`);
  }
  const url = `ws://127.0.0.1:${String(port)}/ws/docs?${query.join('&')}`;
  const ws = new WebSocket(url, { headers: buildHeaders(sid, origin) });
  openSockets.push(ws);

  return new Promise<number | undefined>((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('expected the upgrade to be rejected, but the socket opened'));
    });
    ws.on('error', () => undefined);
  });
}

/** Event-driven poll (NOT a fixed sleep) for a synchronous convergence check. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor: condition not met within ${String(timeoutMs)}ms`);
}

/** Async variant for conditions that must query the DB (e.g. the event store). */
async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitForAsync: condition not met within ${String(timeoutMs)}ms`);
}

/** Reconstructs a `doc` from a persisted snapshot Buffer (a `Y.encodeStateAsUpdate` blob). */
function reconstruct(snapshot: Buffer): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return doc;
}

describe('DocCollabGateway PR4b — durable snapshot persistence + lifecycle (real Postgres + real HTTP + real ws)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;

  // A long-lived app used ONLY for HTTP seeding and for reading the durable
  // store back (its reconstruction/event-store services read the shared DB, so
  // they see exactly what survived a graceful restart or a crash).
  let harnessApp: INestApplication;
  let AppModuleRef: typeof AppModuleType;

  // Every per-test app is tracked here so `afterAll` can close any a test left
  // open (notably the CRASH case, which deliberately never closes its app).
  const startedApps = new Set<INestApplication>();

  // Seeded fixtures (workspace W owned by U; U's raw `sid`). A DISTINCT doc per
  // test keeps their event streams / snapshots isolated.
  let sid: string;
  let userIdU: string;
  let workspaceIdW: string;
  let docGraceful: string;
  let docCrash: string;
  let docEdited: string;
  let docCap: string;

  async function startApp(): Promise<{ app: INestApplication; port: number }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModuleRef] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    startedApps.add(app);
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    return { app, port: address.port };
  }

  async function stopApp(app: INestApplication): Promise<void> {
    startedApps.delete(app);
    await app.close();
  }

  /** How many `DocumentEdited` events exist for `docId` authored by `actorId`. */
  async function countDocumentEdited(docId: string, actorId: string): Promise<number> {
    const events = await harnessApp.get(EventStoreService).readByWorkspace(workspaceIdW, 0);
    return events.filter((event) => {
      if (event.type !== 'DocumentEdited') {
        return false;
      }
      const payload = event.payload as { docId?: unknown; actorId?: unknown };
      return payload.docId === docId && payload.actorId === actorId;
    }).length;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // DETERMINISM: set BEFORE importing app.module (env is read once at boot).
    // A very long debounce + very high update cap means no automatic snapshot
    // ever fires mid-test — snapshots happen ONLY via the graceful flush.
    process.env.DOC_SNAPSHOT_DEBOUNCE_MS = '600000';
    process.env.DOC_SNAPSHOT_MAX_UPDATES = '1000000';
    // Case 4 needs a small, deterministic per-room connection cap.
    process.env.DOC_MAX_CONNECTIONS_PER_ROOM = '2';

    await runMigrations(container.getConnectionUri());

    const appModule = await import('../app.module.js');
    AppModuleRef = appModule.AppModule;

    const moduleRef = await Test.createTestingModule({ imports: [AppModuleRef] }).compile();
    harnessApp = moduleRef.createNestApplication();
    await harnessApp.init();
    await harnessApp.listen(0);
    const harnessServer = harnessApp.getHttpServer() as Server;

    const createDoc = async (
      cookie: string,
      workspaceId: string,
      title: string,
    ): Promise<string> => {
      const res = await request(harnessServer)
        .post(`/workspaces/${workspaceId}/objects`)
        .set('Cookie', cookie)
        .send({ objectType: 'doc', title });
      expect(res.status).toBe(201);
      return (res.body as ObjectEnvelope).object.id;
    };

    const registerU = await request(harnessServer)
      .post('/auth/register')
      .send({ email: freshEmail(), password: PASSWORD });
    expect(registerU.status).toBe(201);
    userIdU = (registerU.body as UserEnvelope).user.id;
    const cookieU = (registerU.get('Set-Cookie') ?? [])
      .map((c) => c.split(';')[0] ?? '')
      .join('; ');

    const workspaceU = await request(harnessServer)
      .post('/workspaces')
      .set('Cookie', cookieU)
      .send({ name: 'Persistence Workspace W' });
    expect(workspaceU.status).toBe(201);
    workspaceIdW = (workspaceU.body as WorkspaceEnvelope).workspace.id;

    docGraceful = await createDoc(cookieU, workspaceIdW, 'Doc — graceful restart');
    docCrash = await createDoc(cookieU, workspaceIdW, 'Doc — simulated crash');
    docEdited = await createDoc(cookieU, workspaceIdW, 'Doc — session audit');
    docCap = await createDoc(cookieU, workspaceIdW, 'Doc — connection cap');

    // Raw `sid` cookie value for U (the gateway parses this from headers).
    const session = await harnessApp.get(SessionService).createSession(userIdU);
    sid = session.id;
  }, 120_000);

  afterAll(async () => {
    for (const socket of openSockets) {
      try {
        socket.terminate();
      } catch {
        // best-effort cleanup
      }
    }
    // Close any per-test app still running (the crash case intentionally left
    // one open). Best-effort so one failure doesn't mask the containers' stop.
    for (const app of startedApps) {
      try {
        await app.close();
      } catch {
        // best-effort cleanup
      }
    }
    await harnessApp.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  it('graceful restart is LOSSLESS: onModuleDestroy flush persists a snapshot that reconstructs the edits (Kabul Kriteri #4a)', async () => {
    const { app: app1, port: port1 } = await startApp();

    const client = connectYDocClient(port1, { docId: docGraceful, sid });
    await client.whenSynced;
    client.doc.getMap('root').set('k', 'v-graceful');
    client.doc.getText('body').insert(0, 'hello-graceful');

    // Confirm the SERVER room actually received the edits before we shut down,
    // so this proves flush-of-server-state, not a lucky client-only artifact.
    const confirm = connectYDocClient(port1, { docId: docGraceful, sid });
    await confirm.whenSynced;
    await waitFor(
      () =>
        confirm.doc.getMap('root').get('k') === 'v-graceful' &&
        confirm.doc.getText('body').toJSON() === 'hello-graceful',
    );

    // Graceful shutdown -> onModuleDestroy flush -> snapshot + projection.
    await stopApp(app1);

    // Fresh process (app2) reading the durable store must see the snapshot.
    const { app: app2, port: port2 } = await startApp();
    const reconstruction = app2.get(DocumentReconstructionService);
    const snap = await reconstruction.getLatestSnapshot(docGraceful);

    expect(snap).not.toBeNull();
    const restored = reconstruct((snap ?? { snapshot: Buffer.alloc(0) }).snapshot);
    expect(restored.getMap('root').get('k')).toBe('v-graceful');
    expect(restored.getText('body').toJSON()).toBe('hello-graceful');

    // BONUS end-to-end: a NEW client via app2 already reflects the edits after
    // sync — restart recovery is observable to a live collaborator.
    const recovered = connectYDocClient(port2, { docId: docGraceful, sid });
    await recovered.whenSynced;
    await waitFor(
      () =>
        recovered.doc.getMap('root').get('k') === 'v-graceful' &&
        recovered.doc.getText('body').toJSON() === 'hello-graceful',
    );

    await stopApp(app2);
  }, 30_000);

  it('simulated CRASH loses only the un-flushed window; the last real snapshot survives (Kabul Kriteri #4b)', async () => {
    // This is the deliberate BOUNDED-LOSS trade-off from ADR-0011 §(c). It is
    // tested SEPARATELY from the graceful case (do NOT merge them): graceful =
    // lossless, crash = last-snapshot-wins with the un-flushed tail dropped.

    // --- Establish a persisted BASELINE via a graceful flush. ---
    const { app: appA, port: portA } = await startApp();
    const a1 = connectYDocClient(portA, { docId: docCrash, sid });
    await a1.whenSynced;
    a1.doc.getMap('root').set('k', 'baseline');

    const aConfirm = connectYDocClient(portA, { docId: docCrash, sid });
    await aConfirm.whenSynced;
    await waitFor(() => aConfirm.doc.getMap('root').get('k') === 'baseline');
    await stopApp(appA); // flush -> baseline persisted

    // --- Enter the crash window: appB loads the baseline, takes a new edit. ---
    // We deliberately keep NO reference to appB (we never gracefully close it —
    // that's the crash). `startApp` already tracked it in `startedApps`, so
    // `afterAll` still frees its port/sockets after the test has asserted.
    const { port: portB } = await startApp();
    const b1 = connectYDocClient(portB, { docId: docCrash, sid });
    await b1.whenSynced;
    expect(b1.doc.getMap('root').get('k')).toBe('baseline'); // baseline reloaded
    b1.doc.getMap('root').set('k2', 'lost-on-crash');

    const bConfirm = connectYDocClient(portB, { docId: docCrash, sid });
    await bConfirm.whenSynced;
    await waitFor(() => bConfirm.doc.getMap('root').get('k2') === 'lost-on-crash');

    // --- SIMULATE CRASH: do NOT close appB (no onModuleDestroy, no flush). ---
    // Read the durable store via the harness (a fresh reader). Only the
    // baseline snapshot exists; edit2 lived only in appB's in-memory room.
    const snap = await harnessApp.get(DocumentReconstructionService).getLatestSnapshot(docCrash);
    expect(snap).not.toBeNull();
    const restored = reconstruct((snap ?? { snapshot: Buffer.alloc(0) }).snapshot);
    expect(restored.getMap('root').get('k')).toBe('baseline'); // survived
    expect(restored.getMap('root').has('k2')).toBe(false); // un-flushed -> lost

    // appB is intentionally left running (crashed process); afterAll closes it.
  }, 30_000);

  it('appends DocumentEdited exactly ONCE per session per actor, regardless of how many edits', async () => {
    const { app, port } = await startApp();
    const client = connectYDocClient(port, { docId: docEdited, sid });
    await client.whenSynced;

    // Several distinct edits by the SAME user in the SAME room.
    client.doc.getMap('root').set('a', 1);
    client.doc.getMap('root').set('b', 2);
    client.doc.getText('body').insert(0, 'multi-edit');

    const confirm = connectYDocClient(port, { docId: docEdited, sid });
    await confirm.whenSynced;
    await waitFor(
      () =>
        confirm.doc.getMap('root').get('a') === 1 &&
        confirm.doc.getMap('root').get('b') === 2 &&
        confirm.doc.getText('body').toJSON() === 'multi-edit',
    );

    // The audit event should have landed by now (first-edit trigger).
    await waitForAsync(async () => (await countDocumentEdited(docEdited, userIdU)) >= 1);

    // One MORE edit, confirmed server-side via the ALREADY-connected `confirm`
    // client (reused rather than opening a third socket, so this room never
    // exceeds DOC_MAX_CONNECTIONS_PER_ROOM=2 from the cap test) — a per-keystroke
    // design would have appended another DocumentEdited by the time this lands.
    client.doc.getMap('root').set('c', 3);
    await waitFor(() => confirm.doc.getMap('root').get('c') === 3);

    expect(await countDocumentEdited(docEdited, userIdU)).toBe(1);

    await stopApp(app);
  }, 30_000);

  it('rejects connections beyond DOC_MAX_CONNECTIONS_PER_ROOM for the same room (DoS cap)', async () => {
    const { app, port } = await startApp();

    // Cap is 2 (set in beforeAll): the first two authorized clients succeed.
    const first = connectYDocClient(port, { docId: docCap, sid });
    const second = connectYDocClient(port, { docId: docCap, sid });
    await Promise.all([first.whenSynced, second.whenSynced]);

    // The THIRD connection to the SAME docId must be REJECTED at the upgrade.
    // Pinned to 503 ("room full" / service unavailable). NOTE to implementer:
    // if you choose 429 (Too Many Requests) instead, update this assertion —
    // the contract only requires a deterministic 4xx/5xx that is NOT accepted.
    const status = await whenUpgradeRejected(port, { docId: docCap, sid });
    expect(status).toBe(503);

    await stopApp(app);
  }, 30_000);
});
