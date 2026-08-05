import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';

import type * as Y from 'yjs';

/**
 * F1-T11 PR6 — client-side Yjs WebSocket provider for the collaborative doc
 * editor. Speaks the SAME y-protocols framing as the server gateway and its
 * PR4a integration test client (`connectYDocClient` in
 * apps/server/src/docs/doc-collab-gateway.integration.test.ts): MESSAGE_SYNC
 * for the sync protocol, MESSAGE_AWARENESS for awareness relay.
 */

// y-websocket message framing constants (mirror the server gateway/test client).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// How long to wait before attempting to reconnect after an unexpected close.
const RECONNECT_DELAY_MS = 1500;

/**
 * Builds the gateway WebSocket URL for a doc room. Turns the current origin's
 * http(s) scheme into ws(s) and targets the server's `/ws/docs?docId=<ULID>`
 * route (pinned by the PR4a gateway integration test).
 */
export function buildDocWsUrl(docId: string): string {
  return `${location.origin.replace(/^http/, 'ws')}/ws/docs?docId=${encodeURIComponent(docId)}`;
}

/** Normalizes a WebSocket 'message' event payload to a `Uint8Array`. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}

export class DocGatewayProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private ws: WebSocket;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  private readonly _awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;

  constructor(
    private readonly wsUrl: string,
    doc: Y.Doc,
  ) {
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);

    this._docUpdateHandler = (update: Uint8Array, origin: unknown): void => {
      if (origin === this) {
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    };
    this.doc.on('update', this._docUpdateHandler);

    this._awarenessUpdateHandler = ({
      added,
      updated,
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    }): void => {
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
      );
      this.send(encoding.toUint8Array(encoder));
    };
    this.awareness.on('update', this._awarenessUpdateHandler);

    this.ws = this.connect();
  }

  private connect(): WebSocket {
    const ws = new WebSocket(this.wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = (): void => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
    };

    ws.onmessage = (ev: MessageEvent): void => {
      const bytes = toBytes(ev.data);
      const decoder = decoding.createDecoder(bytes);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 1) {
          this.send(encoding.toUint8Array(encoder));
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
      }
    };

    ws.onclose = (): void => {
      this.scheduleReconnect();
    };

    // Swallow low-level errors; a reconnect is driven by 'close'.
    ws.onerror = (): void => undefined;

    return ws;
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) {
        return;
      }
      this.ws = this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private send(payload: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      // `.slice()` copies into a fresh, non-shared ArrayBuffer so the payload
      // satisfies the DOM `WebSocket.send` BufferSource type under strict TS.
      this.ws.send(payload.slice());
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.doc.off('update', this._docUpdateHandler);
    this.awareness.off('update', this._awarenessUpdateHandler);
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      'provider destroyed',
    );
    this.ws.close();
    this.awareness.destroy();
  }
}
