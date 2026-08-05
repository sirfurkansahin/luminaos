import { Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { AppError } from '@luminaos/shared';

import { DocumentReconstructionService } from './document-reconstruction.service.js';
import { SessionService } from '../auth/session.service.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { objectsView } from '../db/schema/objects-view.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData } from 'ws';

// y-websocket message framing constants (must match the test client and the
// canonical y-websocket protocol).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const WS_PATH = '/ws/docs';

// `sessions.id` is a Postgres `uuid` column: a `sid` cookie that is not a
// well-formed UUID can never match a real session and, if passed to the query,
// would make `pg` raise a raw "invalid input syntax for type uuid" driver error
// (a non-`AppError` → 500). Validating the shape here maps a malformed session
// id to the same 401 as an unknown one — mirroring `WorkspaceMembershipService`'s
// own UUID guard, and never leaking whether a given id shape is "valid".
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

/**
 * An in-memory collaboration room keyed by `docId` (ADR-0011 §(b): the room's
 * `Y.Doc` is the single authoritative writer for a document). `conns` maps each
 * live socket to the set of awareness client IDs it controls, so they can be
 * cleared on disconnect (mirrors the canonical y-websocket server).
 */
interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>;
  updateHandler: (update: Uint8Array, origin: unknown) => void;
  awarenessHandler: (changes: AwarenessChanges, origin: unknown) => void;
}

interface ConnectionContext {
  docId: string;
  workspaceId: string;
  userId: string;
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

/**
 * F1-T11 PR4a — real-time Yjs CRDT collaboration WebSocket gateway.
 *
 * This is a plain `@Injectable()` provider (NOT `@WebSocketGateway`): Yjs
 * speaks a BINARY protocol that NestJS's JSON message routing cannot carry, so
 * we attach a raw `ws` `WebSocketServer({ noServer: true })` to the existing
 * HTTP server's `upgrade` event via `HttpAdapterHost`. Authorization happens on
 * the upgrade handshake — BEFORE the socket is accepted — reusing the same
 * `SessionService`/`WorkspaceMembershipService` the HTTP layer uses (ADR-0011
 * §(d)). Once accepted, the connection runs the standard y-protocols sync +
 * awareness relay (mirrors the canonical y-websocket server `utils.js`).
 *
 * PR4a only relays and loads initial state from the latest persisted snapshot;
 * writing snapshots back to the event log is PR4b (which will also add the
 * synchronous SIGTERM flush in `onModuleDestroy`).
 */
@Injectable()
export class DocCollabGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | undefined;
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessionService: SessionService,
    private readonly workspaceMembershipService: WorkspaceMembershipService,
    private readonly reconstruction: DocumentReconstructionService,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  /**
   * PR4a stub: no snapshot flush yet (PR4b adds the synchronous SIGTERM flush
   * here). We still tear the `WebSocketServer` down cleanly so app/test
   * shutdown does not hang on lingering sockets.
   */
  onModuleDestroy(): void {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');

    // Only claim upgrades for our own path; leave anything else untouched so
    // other potential upgrade handlers (or Node's default teardown) can act.
    if (url.pathname !== WS_PATH) {
      return;
    }

    // (1) ORIGIN CHECK (CSWSH): if the browser-supplied `Origin` header is
    // PRESENT and does not exactly match the allowlisted web origin, refuse the
    // upgrade — a malicious page must not be able to ride the victim's `sid`
    // cookie onto this socket. An ABSENT `Origin` (non-browser clients, e.g.
    // server-to-server) is allowed through: they cannot mount a CSWSH attack
    // and never send the header. Exact-match, mirroring `cors.middleware.ts`.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== env.webOrigin) {
      this.reject(socket, 403, 'Forbidden');
      return;
    }

    // (2) The doc's workspace is resolved AUTHORITATIVELY server-side below; the
    // client only supplies which doc it wants to open.
    const docId = url.searchParams.get('docId');
    if (docId === null || docId.length === 0) {
      this.reject(socket, 400, 'Bad Request');
      return;
    }

    // (3) Session auth.
    const sid = this.parseCookie(req.headers.cookie, 'sid');
    if (sid === null || !UUID_PATTERN.test(sid)) {
      this.reject(socket, 401, 'Unauthorized');
      return;
    }

    try {
      const session = await this.sessionService.getActiveSession(sid);
      if (session === null) {
        this.reject(socket, 401, 'Unauthorized');
        return;
      }

      const user = await this.sessionService.findUserById(session.userId);
      if (user === null) {
        this.reject(socket, 401, 'Unauthorized');
        return;
      }

      // (4) Resolve the doc's OWNING workspace server-side. A non-existent doc,
      // a non-`doc` object, or a soft-deleted one is not an editable doc -> 404.
      const resolved = await this.resolveDocWorkspace(docId);
      if (resolved === null) {
        this.reject(socket, 404, 'Not Found');
        return;
      }

      // (5) Membership is checked against the doc's OWN workspace (closing the
      // cross-workspace IDOR): a member of some OTHER workspace can no longer
      // open this doc. Throws `ForbiddenError` (403) if not a member,
      // `UnauthorizedError` (401) if the user id is missing — same
      // classification as the HTTP guard.
      await this.workspaceMembershipService.assertMembership(user.id, resolved.workspaceId);

      const wss = this.wss;
      if (!wss) {
        this.reject(socket, 500, 'Internal Server Error');
        return;
      }

      // (6) Accept.
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, { docId, workspaceId: resolved.workspaceId, userId: user.id });
      });
    } catch (err) {
      const status = err instanceof AppError ? err.statusCode : 500;
      this.reject(socket, status, this.reasonFor(status));
    }
  }

  /**
   * Resolves a `docId` to its OWNING workspace from the `objects_view`
   * read-model, so authorization is never anchored on a client-supplied
   * workspace. Returns `null` when the id has no row, is not a `doc`, or has
   * been soft-deleted — all "this is not an editable doc" cases the caller
   * maps to 404.
   */
  private async resolveDocWorkspace(docId: string): Promise<{ workspaceId: string } | null> {
    const [row] = await this.db
      .select({
        workspaceId: objectsView.workspaceId,
        type: objectsView.type,
        lifecycle: objectsView.lifecycle,
      })
      .from(objectsView)
      .where(eq(objectsView.id, docId))
      .limit(1);

    if (!row || row.type !== 'doc' || row.lifecycle === 'deleted') {
      return null;
    }

    return { workspaceId: row.workspaceId };
  }

  /**
   * Writes a raw HTTP error response and destroys the socket WITHOUT completing
   * the upgrade, so the `ws` client surfaces an `'unexpected-response'` event
   * carrying `res.statusCode`.
   */
  private reject(socket: Duplex, code: number, reason: string): void {
    socket.write(
      `HTTP/1.1 ${String(code)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  private reasonFor(status: number): string {
    switch (status) {
      case 400:
        return 'Bad Request';
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 404:
        return 'Not Found';
      default:
        return 'Internal Server Error';
    }
  }

  /**
   * Minimal `sid`-cookie parser. `cookie-parser` is HTTP-middleware-only and
   * never runs on the upgrade handshake, so we parse the raw header here.
   */
  private parseCookie(header: string | undefined, name: string): string | null {
    if (header === undefined) {
      return null;
    }
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) {
        continue;
      }
      if (part.slice(0, eq).trim() === name) {
        const value = part.slice(eq + 1).trim();
        return value.length === 0 ? null : value;
      }
    }
    return null;
  }

  private async getOrCreateRoom(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing) {
      return existing;
    }

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    // The server does not participate in awareness; it only relays clients'.
    awareness.setLocalState(null);

    // Load initial state from the latest persisted snapshot (ADR-0011 §(c):
    // apply only the most recent full-state snapshot).
    const snap = await this.reconstruction.getLatestSnapshot(docId);
    if (snap) {
      Y.applyUpdate(doc, snap.snapshot);
    }

    // Another connection may have created the room while we awaited the load.
    const raced = this.rooms.get(docId);
    if (raced) {
      doc.destroy();
      return raced;
    }

    const room: Room = {
      doc,
      awareness,
      conns: new Map<WebSocket, Set<number>>(),
      updateHandler: () => undefined,
      awarenessHandler: () => undefined,
    };

    // Broadcast local doc updates to every conn except the one that produced
    // them (the origin is the `ws` passed to `readSyncMessage`).
    room.updateHandler = (update: Uint8Array, origin: unknown): void => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns.keys()) {
        if (conn !== origin) {
          this.send(conn, message);
        }
      }
    };

    // Relay awareness updates to all conns and track which client IDs each
    // socket controls (so they can be cleaned up on disconnect).
    room.awarenessHandler = (changes: AwarenessChanges, origin: unknown): void => {
      const changedClients = [...changes.added, ...changes.updated, ...changes.removed];
      if (origin instanceof WebSocket) {
        const controlled = room.conns.get(origin);
        if (controlled) {
          for (const id of changes.added) {
            controlled.add(id);
          }
          for (const id of changes.removed) {
            controlled.delete(id);
          }
        }
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
      );
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns.keys()) {
        this.send(conn, message);
      }
    };

    doc.on('update', room.updateHandler);
    awareness.on('update', room.awarenessHandler);

    this.rooms.set(docId, room);
    return room;
  }

  private onConnection(ws: WebSocket, ctx: ConnectionContext): void {
    ws.binaryType = 'arraybuffer';

    // Room creation is async (it loads the latest snapshot from Postgres). The
    // `ws` library DROPS 'message' events emitted while no listener is attached,
    // so we must attach the listener SYNCHRONOUSLY here — otherwise a client's
    // syncStep1/edits sent during the snapshot load (a real event-loop gap for
    // the first client of a room) would be lost, hanging its `whenSynced`.
    // Messages that arrive before the room is ready are buffered and drained.
    let room: Room | undefined;
    const pending: Uint8Array[] = [];

    ws.on('message', (data: RawData) => {
      const bytes = toBytes(data);
      if (room === undefined) {
        pending.push(bytes);
        return;
      }
      try {
        this.onMessage(ws, room, bytes);
      } catch {
        // Never surface protocol-decode failures as a crash, and never log
        // document content (CLAUDE.md: no user data in logs).
      }
    });

    ws.on('error', () => {
      // Defensive: swallow low-level socket errors (no PII logging).
    });

    void this.getOrCreateRoom(ctx.docId).then((readyRoom) => {
      room = readyRoom;
      readyRoom.conns.set(ws, new Set<number>());

      ws.on('close', () => {
        this.onClose(ws, readyRoom, ctx.docId);
      });

      // If the socket already closed while the room was loading, clean up now.
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        this.onClose(ws, readyRoom, ctx.docId);
        return;
      }

      // syncStep1 on connect.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, readyRoom.doc);
      this.send(ws, encoding.toUint8Array(encoder));

      // Send the current awareness states to the newly joined client.
      const states = readyRoom.awareness.getStates();
      if (states.size > 0) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(readyRoom.awareness, [...states.keys()]),
        );
        this.send(ws, encoding.toUint8Array(awarenessEncoder));
      }

      // Drain anything the client sent before the room was ready.
      for (const bytes of pending) {
        try {
          this.onMessage(ws, readyRoom, bytes);
        } catch {
          // See the message listener above.
        }
      }
      pending.length = 0;
    });
  }

  private onMessage(ws: WebSocket, room: Room, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // Applies remote updates with `ws` as origin so our broadcaster does not
      // echo them straight back to the sender.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
      if (encoding.length(encoder) > 1) {
        this.send(ws, encoding.toUint8Array(encoder));
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
    }
  }

  private onClose(ws: WebSocket, room: Room, docId: string): void {
    const controlled = room.conns.get(ws);
    room.conns.delete(ws);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
    }

    // PR4a: an empty room can be discarded because its state is reloaded from
    // the latest snapshot on the next join. PR4b will flush before removal.
    if (room.conns.size === 0) {
      room.doc.off('update', room.updateHandler);
      room.awareness.off('update', room.awarenessHandler);
      room.awareness.destroy();
      room.doc.destroy();
      this.rooms.delete(docId);
    }
  }

  private send(ws: WebSocket, message: Uint8Array): void {
    if (ws.readyState !== WebSocket.CONNECTING && ws.readyState !== WebSocket.OPEN) {
      ws.close();
      return;
    }
    try {
      ws.send(message, (err) => {
        if (err) {
          ws.close();
        }
      });
    } catch {
      ws.close();
    }
  }
}
