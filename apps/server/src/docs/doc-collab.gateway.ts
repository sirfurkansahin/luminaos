import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { AppError, VersionConflictError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { DocumentReconstructionService } from './document-reconstruction.service.js';
import { DocumentSnapshotsProjection } from './document-snapshots.projection.js';
import {
  documentContentSnapshottedPayloadSchema,
  documentEditedPayloadSchema,
} from './dto/document-snapshot.schema.js';
import { SessionService } from '../auth/session.service.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { objectsView } from '../db/schema/objects-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
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

// Every doc event stream is an object stream — the same `streamType` the HTTP
// `ObjectsService` writes (`objects.service.ts`'s `STREAM_TYPE`), so a
// snapshot/audit event lands on the doc object's OWN stream.
const STREAM_TYPE = 'lumina-object';

// The system actor recorded for server-written `DocumentContentSnapshotted`
// events (the gateway, not a human, encoded the room state).
const SNAPSHOT_ACTOR: Actor = { type: 'system', id: 'doc-collab-gateway' };

// How many optimistic-concurrency retries a single append attempts before
// giving up (another writer kept winning the version race). A small, bounded
// number: doc streams are low-contention (the gateway is the only snapshotter).
const MAX_APPEND_ATTEMPTS = 5;

// Frame-size DoS cap on the `WebSocketServer` (F1-T11 PR4b): a single ws frame
// larger than this is rejected by `ws` before it reaches our handlers. Set a
// little above `MAX_SNAPSHOT_BYTES` (5 MB) so a legitimate full-state sync
// frame still fits, while a hostile multi-hundred-MB frame cannot exhaust
// memory.
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;

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
  /** Maps each live socket to the id of the user controlling it, so the once-per-session `DocumentEdited` audit event can be attributed without a Nest request context. */
  connUsers: Map<WebSocket, string>;
  updateHandler: (update: Uint8Array, origin: unknown) => void;
  awarenessHandler: (changes: AwarenessChanges, origin: unknown) => void;
  /** The doc object's OWN event stream id — snapshots/audit events are appended here. */
  streamId: string;
  /** The doc's owning workspace id — carried on every appended event. */
  workspaceId: string;
  /** Number of client-originated updates since the last successful snapshot (0 == clean, nothing to flush). */
  dirtyCount: number;
  /** Pending debounce timer; `undefined` when no snapshot is scheduled. */
  debounceTimer: NodeJS.Timeout | undefined;
  /** Room-local monotonic snapshot counter (the payload `version`); starts at 0, first snapshot writes 1. */
  snapshotVersion: number;
  /** Guard against two overlapping snapshot writes for the same room. */
  snapshotting: boolean;
  /** Actor ids that have already emitted a `DocumentEdited` for this room-session (dedupe: one per actor). */
  editedActors: Set<string>;
}

interface ConnectionContext {
  docId: string;
  workspaceId: string;
  streamId: string;
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

  private readonly logger = new Logger(DocCollabGateway.name);

  // A single, stable projection instance for this gateway's lifetime, so the
  // `document_snapshots` read model materializes right after each snapshot
  // append (mirrors `ObjectsService`'s own "stable projection instance").
  private readonly snapshotProjection = new DocumentSnapshotsProjection();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessionService: SessionService,
    private readonly workspaceMembershipService: WorkspaceMembershipService,
    private readonly reconstruction: DocumentReconstructionService,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    // `maxPayload` caps the size of a single ws frame (DoS defense, F1-T11
    // PR4b) — see `MAX_WS_PAYLOAD_BYTES`.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  /**
   * Graceful shutdown (ADR-0011 §(c), Kabul Kriteri #4a): before closing the
   * `WebSocketServer`, synchronously flush every dirty room to a snapshot so a
   * PLANNED restart is LOSSLESS. Only an ungraceful crash (which never runs
   * this hook) loses the un-flushed window — the deliberate bounded-loss
   * trade-off. Pending debounce timers are cleared so they cannot fire against
   * a torn-down store afterwards.
   */
  async onModuleDestroy(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.debounceTimer !== undefined) {
        clearTimeout(room.debounceTimer);
        room.debounceTimer = undefined;
      }
    }

    // `allSettled` (not `all`): one room's flush failing must never abort the
    // WSS teardown below. `snapshotRoom` already swallows its own errors, so
    // this is belt-and-suspenders — the teardown always runs.
    await Promise.allSettled(
      [...this.rooms].map(([docId, room]) => this.snapshotRoom(docId, room)),
    );

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

      // (6) DoS caps (F1-T11 PR4b). Enforced DURING the upgrade handshake —
      // before the socket is accepted — so a rejected client surfaces a plain
      // HTTP `503` via `'unexpected-response'`, never an opened-then-closed
      // socket. `503` ("service unavailable" / "room full") is the pinned
      // status. The room may not exist yet (it is created lazily in
      // `onConnection`); when absent we cap the number of distinct rooms, when
      // present we cap concurrent connections to that one room. This is a
      // best-effort admission check (a tiny TOCTOU window remains between this
      // peek and `onConnection` populating `conns`), which is acceptable for a
      // coarse DoS guard.
      const existingRoom = this.rooms.get(docId);
      if (existingRoom === undefined) {
        if (this.rooms.size >= env.docMaxRooms) {
          this.reject(socket, 503, 'Service Unavailable');
          return;
        }
      } else if (existingRoom.conns.size >= env.docMaxConnectionsPerRoom) {
        this.reject(socket, 503, 'Service Unavailable');
        return;
      }

      // (7) Accept.
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, {
          docId,
          workspaceId: resolved.workspaceId,
          streamId: resolved.streamId,
          userId: user.id,
        });
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
  private async resolveDocWorkspace(
    docId: string,
  ): Promise<{ workspaceId: string; streamId: string } | null> {
    const [row] = await this.db
      .select({
        workspaceId: objectsView.workspaceId,
        streamId: objectsView.streamId,
        type: objectsView.type,
        lifecycle: objectsView.lifecycle,
      })
      .from(objectsView)
      .where(eq(objectsView.id, docId))
      .limit(1);

    if (!row || row.type !== 'doc' || row.lifecycle === 'deleted') {
      return null;
    }

    return { workspaceId: row.workspaceId, streamId: row.streamId };
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
      case 503:
        return 'Service Unavailable';
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

  private async getOrCreateRoom(ctx: ConnectionContext): Promise<Room> {
    const { docId, workspaceId, streamId } = ctx;
    const existing = this.rooms.get(docId);
    if (existing) {
      return existing;
    }

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    // The server does not participate in awareness; it only relays clients'.
    awareness.setLocalState(null);

    // Load initial state from the latest persisted snapshot (ADR-0011 §(c):
    // apply only the most recent full-state snapshot). Scoped to the doc's own
    // workspace (defense in depth). Applied with a NON-WebSocket origin, so the
    // `updateHandler`'s dirty-marking below never counts this load as an edit.
    const snap = await this.reconstruction.getLatestSnapshot(docId, workspaceId);
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
      connUsers: new Map<WebSocket, string>(),
      updateHandler: () => undefined,
      awarenessHandler: () => undefined,
      streamId,
      workspaceId,
      dirtyCount: 0,
      debounceTimer: undefined,
      snapshotVersion: 0,
      snapshotting: false,
      editedActors: new Set<string>(),
    };

    // Broadcast local doc updates to every conn except the one that produced
    // them (the origin is the `ws` passed to `readSyncMessage`). A client-
    // originated update (origin is a `WebSocket`) also marks the room dirty for
    // the snapshot writer and, on the first such update from a given actor,
    // emits the once-per-session `DocumentEdited` audit event.
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

      if (origin instanceof WebSocket) {
        this.markRoomDirty(docId, room);

        const userId = room.connUsers.get(origin);
        if (userId !== undefined && !room.editedActors.has(userId)) {
          // Add BEFORE the async append so a burst of edits cannot enqueue a
          // second append for the same actor.
          room.editedActors.add(userId);
          void this.appendDocumentEdited(room, docId, userId);
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

    void this.getOrCreateRoom(ctx).then((readyRoom) => {
      room = readyRoom;
      readyRoom.conns.set(ws, new Set<number>());
      readyRoom.connUsers.set(ws, ctx.userId);

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
    room.connUsers.delete(ws);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
    }

    // PR4b: an emptied room is FLUSHED (if dirty) before being discarded, so an
    // edit made just before the last collaborator leaves is not lost even if
    // the debounce timer never fired. The flush is async; the room is not
    // removed until it completes, and a re-check guards against a new
    // connection having joined during the flush.
    if (room.conns.size === 0) {
      // Fire-and-forget: `snapshotRoom` inside already swallows operational
      // errors; the defensive `.catch` guards against any teardown-path throw
      // so an emptied-room flush can never surface an unhandled rejection.
      void this.flushAndDiscardRoom(docId, room).catch(() => {
        this.logger.warn(
          `Failed to flush/discard an emptied document room (stream ${room.streamId}).`,
        );
      });
    }
  }

  /**
   * Snapshots a now-empty room (if dirty), then tears it down — unless a new
   * connection joined while the async flush was in flight, in which case the
   * live room is kept intact.
   */
  private async flushAndDiscardRoom(docId: string, room: Room): Promise<void> {
    await this.snapshotRoom(docId, room);

    if (room.conns.size > 0) {
      // Reused during the flush: keep it.
      return;
    }

    if (room.debounceTimer !== undefined) {
      clearTimeout(room.debounceTimer);
      room.debounceTimer = undefined;
    }
    room.doc.off('update', room.updateHandler);
    room.awareness.off('update', room.awarenessHandler);
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(docId);
  }

  /**
   * Marks a room dirty on a client-originated update and (re)arms the snapshot
   * trigger: an immediate flush once `docSnapshotMaxUpdates` updates have
   * accumulated, otherwise a debounced flush `docSnapshotDebounceMs` after the
   * last edit (ADR-0011 §(c): "N update VEYA 10 sn hareketsizlik").
   */
  private markRoomDirty(docId: string, room: Room): void {
    room.dirtyCount += 1;

    if (room.dirtyCount >= env.docSnapshotMaxUpdates) {
      if (room.debounceTimer !== undefined) {
        clearTimeout(room.debounceTimer);
        room.debounceTimer = undefined;
      }
      void this.snapshotRoom(docId, room);
      return;
    }

    if (room.debounceTimer !== undefined) {
      clearTimeout(room.debounceTimer);
    }
    room.debounceTimer = setTimeout(() => {
      room.debounceTimer = undefined;
      void this.snapshotRoom(docId, room);
    }, env.docSnapshotDebounceMs);
  }

  /**
   * Encodes the room's `Y.Doc` as a full-state Yjs update, VALIDATES it against
   * `documentContentSnapshottedPayloadSchema` BEFORE appending (a HIGH control:
   * an oversized/malformed snapshot must never become an immutable event that
   * would stall the projection forever), then appends a
   * `DocumentContentSnapshotted` event to the doc's own stream with
   * optimistic-concurrency retry and catches the snapshot projection up so
   * `document_snapshots` materializes. No-op when the room is clean or a
   * snapshot is already in flight.
   */
  private async snapshotRoom(docId: string, room: Room): Promise<void> {
    if (room.dirtyCount === 0 || room.snapshotting) {
      return;
    }

    room.snapshotting = true;
    try {
      if (room.debounceTimer !== undefined) {
        clearTimeout(room.debounceTimer);
        room.debounceTimer = undefined;
      }

      const update = Y.encodeStateAsUpdate(room.doc);
      const snapshot = Buffer.from(update).toString('base64');
      const version = room.snapshotVersion + 1;
      const payload = { docId, snapshot, version };

      const parsed = documentContentSnapshottedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        // No content/PII in the log — just that a snapshot was rejected.
        this.logger.warn(
          `Rejected an invalid document snapshot before append (stream ${room.streamId}); not persisting.`,
        );
        return;
      }

      const event = this.buildEvent('DocumentContentSnapshotted', payload, SNAPSHOT_ACTOR, room);
      const appended = await this.appendWithRetry(room.streamId, [event]);
      if (!appended) {
        return;
      }

      room.snapshotVersion = version;
      room.dirtyCount = 0;

      await this.projectionRunner.catchUp(this.snapshotProjection);
    } catch {
      // A snapshot write failure (transient DB error, projection catch-up
      // failure, etc.) must NEVER escape as an unhandled promise rejection:
      // these run fire-and-forget (`void`) from the debounce/threshold paths
      // and inside `onModuleDestroy`, where a rejection could crash the process
      // or abort shutdown teardown. We swallow it here — `dirtyCount` is only
      // reset on the success path above, so the room stays dirty and the next
      // trigger (or the graceful flush) retries. No document content/PII logged.
      this.logger.warn(
        `Failed to persist a document snapshot (stream ${room.streamId}); will retry on next trigger.`,
      );
    } finally {
      room.snapshotting = false;
    }
  }

  /**
   * Appends the once-per-session `DocumentEdited` audit event (ADR-0011): a
   * content-free `{ docId, actorId, at }` marking that `userId` edited this doc
   * in this room-session. Best-effort — a failure here never disrupts the live
   * relay (and never logs content/PII).
   */
  private async appendDocumentEdited(room: Room, docId: string, userId: string): Promise<void> {
    const payload = { docId, actorId: userId, at: new Date().toISOString() };

    const parsed = documentEditedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }

    try {
      const event = this.buildEvent('DocumentEdited', payload, { type: 'user', id: userId }, room);
      await this.appendWithRetry(room.streamId, [event]);
    } catch {
      this.logger.warn(`Failed to append a DocumentEdited audit event (stream ${room.streamId}).`);
    }
  }

  /**
   * Optimistic-concurrency append helper: reads the stream's current head as
   * the expected version and appends, retrying on `VersionConflictError` (a
   * concurrent writer advanced the stream). Returns `true` on success, `false`
   * if every attempt lost the race.
   */
  private async appendWithRetry(streamId: string, events: NewDomainEvent[]): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const existing = await this.eventStore.readStream(streamId);
      try {
        await this.eventStore.append(streamId, existing.length, events);
        return true;
      } catch (error) {
        if (error instanceof VersionConflictError) {
          continue;
        }
        throw error;
      }
    }
    return false;
  }

  /** Builds a `NewDomainEvent` for the doc object's own stream (mirrors `objects.service.ts`'s `wrapDrafts` shape). */
  private buildEvent(
    type: string,
    payload: Record<string, unknown>,
    actor: Actor,
    room: Room,
  ): NewDomainEvent {
    return {
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId: room.workspaceId,
      type,
      payload,
      actor,
      occurredAt: new Date(),
    };
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
