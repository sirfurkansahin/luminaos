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

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * F1-T11 PR4a (RED step) — real-time Yjs CRDT collaboration WebSocket gateway.
 *
 * SECURITY-HARDENED REVISION: this file was rewritten after a security review
 * of the original PR4a design found TWO HIGH authorization holes the previous
 * test did not catch:
 *   1. CSWSH — no `Origin` validation on the WS upgrade, so a malicious browser
 *      page could ride the victim's `sid` cookie.
 *   2. Cross-workspace IDOR — the gateway trusted a CLIENT-SUPPLIED
 *      `workspaceId` query param and asserted membership on THAT, never
 *      checking the requested `docId` actually belonged to it. Any member of
 *      ANY workspace could therefore open ANY docId.
 * This revision closes both: the client-supplied `workspaceId` param is GONE,
 * the doc's owning workspace is resolved AUTHORITATIVELY server-side, and the
 * `Origin` header is validated against `env.webOrigin`.
 *
 * Mirrors `../workspaces/workspaces.integration.test.ts`'s Testcontainers
 * harness (postgres:16 + redis:7, DATABASE_URL/REDIS_URL set BEFORE the
 * dynamic `import('../app.module.js')`, `Test.createTestingModule`). UNLIKE
 * that test it must actually START the HTTP server (`app.listen(0)`) so raw
 * `ws` upgrade requests reach the gateway; the bound port is read from
 * `app.getHttpServer().address()`. `afterAll` closes every ws client AND the
 * app so vitest doesn't hang. Nothing here is mocked.
 *
 * ============================================================================
 * CORRECTED CONTRACT PINNED BY THIS FILE (implementer must match precisely):
 *
 *   A `DocCollabGateway` (`./doc-collab.gateway.ts`) — an `@Injectable()`
 *   NestJS provider (NOT `@WebSocketGateway`/`@nestjs/platform-ws`; it attaches
 *   a raw `ws` `WebSocketServer({ noServer: true })` to the HTTP server's
 *   `upgrade` event via `HttpAdapterHost`, because Yjs speaks a BINARY protocol
 *   incompatible with NestJS's JSON message routing).
 *
 *   Path `/ws/docs`, query `?docId=<ULID>` ONLY (no `workspaceId` param).
 *   On upgrade, BEFORE accepting the socket, in THIS order:
 *     1. ORIGIN CHECK (CSWSH): if the `Origin` request header is PRESENT and
 *        does NOT exactly equal `env.webOrigin` -> 403. If `Origin` is ABSENT
 *        (non-browser clients, e.g. the raw `ws` test client by default) ->
 *        allowed to proceed.
 *     2. Missing/empty `docId` -> 400.
 *     3. `sid` cookie missing -> 401; `getActiveSession(sid)` null -> 401;
 *        `findUserById` null -> 401.
 *     4. RESOLVE THE DOC'S WORKSPACE server-side (`objects_view` by `docId`):
 *        no such row, OR type !== 'doc', OR soft-deleted -> 404.
 *     5. `assertMembership(userId, <resolved workspaceId>)` -> 403 if the user
 *        is not a member of the doc's OWN workspace.
 *     6. Success: join the room keyed by `docId`, load the latest persisted
 *        snapshot via `DocumentReconstructionService.getLatestSnapshot` on
 *        first join, then run the standard y-protocols sync + awareness relay
 *        (send syncStep1 on connect, `readSyncMessage`, broadcast
 *        `doc.on('update')` to the room's other conns). PR4a does NOT persist
 *        snapshots back (that's PR4b) — it only relays and loads initial state.
 *
 *   On any auth failure it writes an HTTP error response and destroys the
 *   socket WITHOUT completing the upgrade, with the status codes above.
 *
 * ----------------------------------------------------------------------------
 * RED STATE (expected, today): the CURRENT gateway still uses the old
 * client-supplied `workspaceId` param, has NO `Origin` check, and does NO
 * server-side doc-to-workspace resolution. Against it, the new security cases
 * fail: the cross-workspace IDOR case (5) is wrongly ALLOWED (old design let
 * any workspace member open any docId), the non-existent-docId case (6) is not
 * 404'd, and both the disallowed-origin (8) and allowed-origin (9) cases
 * behave wrong because no `Origin` logic exists. Cases 1-3 also depend on the
 * new `?docId=`-only URL. Nothing wires `/ws/docs` yet in the RED baseline, so
 * sync cases time out and auth cases never see the expected HTTP status.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

// y-websocket message framing constants.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// ULID: 26 Crockford-base32 chars (no I/L/O/U). Used only to fabricate a
// well-formed docId that was NEVER created (the 404 case); real docIds come
// from the seeded `doc` objects below.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(): string {
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out += CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)] ?? '0';
  }
  return out;
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `doc-collab-test-user-${String(emailCounter)}@example.com`;
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

// All clients opened during the run, closed in `afterAll` so vitest exits.
const openSockets: WebSocket[] = [];

/** Builds the `ws` connection headers from the optional `sid`/`origin`. */
function buildHeaders(sid?: string, origin?: string): Record<string, string> {
  return {
    ...(sid !== undefined ? { Cookie: `sid=${sid}` } : {}),
    ...(origin !== undefined ? { Origin: origin } : {}),
  };
}

/**
 * Minimal Yjs WS client mirroring the canonical `y-websocket` client's
 * sync-only path: syncStep1 on open, `readSyncMessage` on each sync frame
 * (replying if the encoder produced content), local `doc` updates pushed back
 * to the server. `whenSynced` resolves once the first syncStep2 is processed.
 *
 * URL now carries `?docId=` ONLY (the client-supplied `workspaceId` param is
 * gone). `origin`, when provided, sets the `Origin` request header so the
 * CSWSH-allowlist path can be exercised end to end.
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

  // Local edits -> server. `readSyncMessage` applies remote updates with
  // origin `ws`, so we skip those to avoid echoing them straight back.
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });

  // Swallow low-level errors so a rejected upgrade in a sync test surfaces as
  // a `whenSynced` timeout rather than an unhandled 'error' crashing the run.
  ws.on('error', () => undefined);

  return { ws, doc, awareness, whenSynced };
}

/**
 * Opens a raw upgrade attempt and resolves with the HTTP status code the
 * server writes when it REJECTS the upgrade (`'unexpected-response'`). Rejects
 * if the socket unexpectedly opens instead.
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

/** Event-driven poll (NOT a fixed sleep) for convergence assertions. */
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

describe('DocCollabGateway — /ws/docs Yjs CRDT collaboration (real Postgres + real HTTP + real ws)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let port: number;

  // User U: valid `sid`, owner/member of workspace W. `docIdW` is a REAL `doc`
  // object living in W (the gateway now requires the doc to exist and resolves
  // its workspace authoritatively).
  let sid: string;
  let docIdW: string;
  // A REAL `doc` object living in a DIFFERENT workspace W2 that U is NOT a
  // member of — drives the cross-workspace IDOR 403 case.
  let docIdW2: string;
  // The allowed browser Origin (from `env.webOrigin`, imported after the
  // Testcontainers env vars are set so the boot-time reader doesn't exit).
  let webOrigin: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    // Import env AFTER DATABASE_URL/REDIS_URL are set (its reader exits the
    // process if they're absent), mirroring the dynamic app.module import.
    const { env } = await import('../config/env.js');
    webOrigin = env.webOrigin;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    // MUST actually listen so raw `ws` upgrade requests reach the gateway.
    await app.listen(0);

    server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    port = address.port;

    const createDoc = async (
      cookie: string,
      workspaceId: string,
      title: string,
    ): Promise<string> => {
      const res = await request(server)
        .post(`/workspaces/${workspaceId}/objects`)
        .set('Cookie', cookie)
        .send({ objectType: 'doc', title });
      expect(res.status).toBe(201);
      return (res.body as ObjectEnvelope).object.id;
    };

    // --- User U + workspace W (U is owner) + real doc `docIdW`. ---
    const registerU = await request(server)
      .post('/auth/register')
      .send({ email: freshEmail(), password: PASSWORD });
    expect(registerU.status).toBe(201);
    const userIdU = (registerU.body as UserEnvelope).user.id;
    const cookieU = (registerU.get('Set-Cookie') ?? [])
      .map((c) => c.split(';')[0] ?? '')
      .join('; ');

    const workspaceU = await request(server)
      .post('/workspaces')
      .set('Cookie', cookieU)
      .send({ name: 'Collab Workspace W' });
    expect(workspaceU.status).toBe(201);
    const workspaceIdW = (workspaceU.body as WorkspaceEnvelope).workspace.id;

    docIdW = await createDoc(cookieU, workspaceIdW, 'Doc in W');

    // Raw `sid` cookie value for U (the gateway parses this from headers).
    const session = await app.get(SessionService).createSession(userIdU);
    sid = session.id;

    // --- User U2 + workspace W2 (U2 is owner; U is NOT a member) + `docIdW2`. ---
    const registerU2 = await request(server)
      .post('/auth/register')
      .send({ email: freshEmail(), password: PASSWORD });
    expect(registerU2.status).toBe(201);
    const cookieU2 = (registerU2.get('Set-Cookie') ?? [])
      .map((c) => c.split(';')[0] ?? '')
      .join('; ');

    const workspaceU2 = await request(server)
      .post('/workspaces')
      .set('Cookie', cookieU2)
      .send({ name: 'Foreign Workspace W2' });
    expect(workspaceU2.status).toBe(201);
    const workspaceIdW2 = (workspaceU2.body as WorkspaceEnvelope).workspace.id;

    docIdW2 = await createDoc(cookieU2, workspaceIdW2, 'Doc in W2');
  }, 120_000);

  afterAll(async () => {
    for (const socket of openSockets) {
      try {
        socket.terminate();
      } catch {
        // best-effort cleanup
      }
    }
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  it('merges concurrent map edits from two authorized clients losslessly on both sides (Kabul Kriteri #2)', async () => {
    const a = connectYDocClient(port, { docId: docIdW, sid });
    const b = connectYDocClient(port, { docId: docIdW, sid });
    await Promise.all([a.whenSynced, b.whenSynced]);

    // Concurrent, independent writes to the same shared map.
    a.doc.getMap('root').set('fromA', 1);
    b.doc.getMap('root').set('fromB', 2);

    const hasBothKeys = (client: YDocClient): boolean => {
      const map = client.doc.getMap('root');
      return map.has('fromA') && map.has('fromB');
    };
    await waitFor(() => hasBothKeys(a) && hasBothKeys(b));

    expect(a.doc.getMap('root').toJSON()).toEqual({ fromA: 1, fromB: 2 });
    expect(b.doc.getMap('root').toJSON()).toEqual({ fromA: 1, fromB: 2 });
  }, 20_000);

  it('converges concurrent Y.Text inserts to an identical string containing both edits', async () => {
    const a = connectYDocClient(port, { docId: docIdW, sid });
    const b = connectYDocClient(port, { docId: docIdW, sid });
    await Promise.all([a.whenSynced, b.whenSynced]);

    a.doc.getText('root-text').insert(0, 'AAA');
    b.doc.getText('root-text').insert(0, 'BBB');

    const textOf = (client: YDocClient): string => client.doc.getText('root-text').toJSON();
    await waitFor(
      () => textOf(a).length === 6 && textOf(b).length === 6 && textOf(a) === textOf(b),
    );

    const merged = textOf(a);
    expect(textOf(b)).toBe(merged);
    expect(merged).toContain('AAA');
    expect(merged).toContain('BBB');
  }, 20_000);

  it('gives a late-joining client the current document state on connect', async () => {
    const a = connectYDocClient(port, { docId: docIdW, sid });
    await a.whenSynced;
    a.doc.getMap('root').set('title', 'A late-join content');

    // Confirm the server room actually holds A's update before C joins, so
    // C's assertion isn't racing the relay — this proves initial-state sync,
    // not a lucky post-join broadcast.
    const confirm = connectYDocClient(port, { docId: docIdW, sid });
    await confirm.whenSynced;
    await waitFor(() => confirm.doc.getMap('root').get('title') === 'A late-join content');

    const c = connectYDocClient(port, { docId: docIdW, sid });
    await c.whenSynced;
    expect(c.doc.getMap('root').get('title')).toBe('A late-join content');
  }, 20_000);

  it('rejects an upgrade with no session cookie, and one with an invalid session, with HTTP 401 (Kabul Kriteri #3)', async () => {
    const noCookieStatus = await whenUpgradeRejected(port, { docId: docIdW });
    expect(noCookieStatus).toBe(401);

    const invalidSidStatus = await whenUpgradeRejected(port, {
      docId: docIdW,
      sid: 'this-is-not-a-real-session-id',
    });
    expect(invalidSidStatus).toBe(401);
  }, 20_000);

  it('rejects a valid user opening a doc in a workspace they are not a member of with HTTP 403 (cross-workspace IDOR — Kabul Kriteri #3)', async () => {
    // THE corrected core case. `docIdW2` lives in W2, which U is NOT a member
    // of. The OLD design trusted a client-supplied `workspaceId` param and
    // only asserted membership on THAT, so U could have passed its OWN W's id
    // and been let in to a foreign doc — the exact IDOR this closes. Now the
    // gateway resolves the doc's workspace (W2) server-side and 403s U.
    const status = await whenUpgradeRejected(port, { docId: docIdW2, sid });
    expect(status).toBe(403);
  }, 20_000);

  it('rejects an upgrade for a well-formed docId that was never created with HTTP 404', async () => {
    const status = await whenUpgradeRejected(port, { docId: ulid(), sid });
    expect(status).toBe(404);
  }, 20_000);

  it('rejects an upgrade missing the docId query param with HTTP 400', async () => {
    const status = await whenUpgradeRejected(port, { sid });
    expect(status).toBe(400);
  }, 20_000);

  it('rejects an upgrade from a disallowed Origin with HTTP 403 (CSWSH protection)', async () => {
    // Proves CSWSH protection: even with a fully valid `sid` and a real doc U
    // can access, a browser Origin that is not `env.webOrigin` is refused, so a
    // malicious page cannot ride the victim's cookie onto this socket.
    const status = await whenUpgradeRejected(port, {
      docId: docIdW,
      sid,
      origin: 'https://evil.example',
    });
    expect(status).toBe(403);
  }, 20_000);

  it('accepts an upgrade whose Origin exactly equals env.webOrigin and syncs', async () => {
    // Proves the Origin allowlist PERMITS the real web origin, not only
    // absent-origin (non-browser) clients.
    const client = connectYDocClient(port, { docId: docIdW, sid, origin: webOrigin });
    await client.whenSynced;
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  }, 20_000);
});
