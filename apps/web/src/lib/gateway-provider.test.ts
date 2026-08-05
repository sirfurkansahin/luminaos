import * as decoding from 'lib0/decoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import { buildDocWsUrl, DocGatewayProvider } from './gateway-provider.js';

/**
 * F1-T11 PR6 (RED step) — client-side Yjs WebSocket provider for the
 * collaborative doc editor. This file pins the contract of a module that does
 * NOT exist yet (apps/web/src/lib/gateway-provider.ts), so every case here is
 * expected to fail purely because `./gateway-provider.js` cannot be resolved
 * until the implementer creates it. That is the intended TDD red state.
 *
 * Contract under test (implementer must build to satisfy):
 *
 *   export function buildDocWsUrl(docId: string): string;
 *     // Returns
 *     //   `${location.origin.replace(/^http/, 'ws')}/ws/docs?docId=${encodeURIComponent(docId)}`
 *     // so an `http://host:port` origin yields `ws://host:port/ws/docs?docId=...`
 *     // and an `https://...` origin yields `wss://...`. The docId is
 *     // URL-encoded. This targets the server's PR4a gateway route
 *     // (`/ws/docs?docId=<ULID>`), pinned by
 *     // apps/server/src/docs/doc-collab-gateway.integration.test.ts.
 *
 *   export class DocGatewayProvider {
 *     readonly doc: Y.Doc;
 *     readonly awareness: awarenessProtocol.Awareness;
 *     constructor(wsUrl: string, doc: Y.Doc);
 *     destroy(): void;
 *   }
 *     // A minimal Yjs provider speaking the SAME y-protocols framing the
 *     // server gateway + its PR4a test client use (MESSAGE_SYNC=0,
 *     // MESSAGE_AWARENESS=1 — see connectYDocClient in the server integration
 *     // test for the exact lib0/y-protocols call shapes). The constructor:
 *     //   - stores `doc`, creates `awareness = new Awareness(doc)`,
 *     //   - opens `new WebSocket(wsUrl)` with `binaryType='arraybuffer'`,
 *     //   - on the socket 'open' event sends ONE MESSAGE_SYNC syncStep1 frame,
 *     //   - on 'message' dispatches MESSAGE_SYNC -> readSyncMessage (replying
 *     //     when the encoder produced content) / MESSAGE_AWARENESS ->
 *     //     applyAwarenessUpdate,
 *     //   - relays local `doc.on('update')` (origin !== this) and
 *     //     `awareness.on('update')` back to the server.
 *     // `destroy()` removes listeners, removes awareness states, closes the
 *     // socket and destroys awareness.
 *
 * Only the browser `WebSocket` global is mocked here (jsdom has none). The
 * Y.Doc, y-protocols and lib0 usage is all REAL, so the frame bytes asserted
 * below are genuinely produced by the provider's encoder.
 */

// y-websocket message framing constants (mirrors the server gateway/test client).
const MESSAGE_SYNC = 0;

type WsEventType = 'open' | 'message' | 'close' | 'error';
type WsHandler = (ev: unknown) => void;

/**
 * Minimal stand-in for the browser `WebSocket`. Captures the constructed url,
 * every `send()` payload (as bytes) and `close()` calls, and lets a test drive
 * the provider by `emit()`-ing lifecycle events. Supports BOTH the
 * `addEventListener` and the `on*`-property styles so it does not over-constrain
 * how the implementer wires listeners.
 */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  binaryType = 'blob';
  readyState: number = MockWebSocket.CONNECTING;
  readonly sent: Uint8Array[] = [];
  readonly close = vi.fn((): void => {
    this.readyState = MockWebSocket.CLOSED;
  });

  onopen: WsHandler | null = null;
  onmessage: WsHandler | null = null;
  onclose: WsHandler | null = null;
  onerror: WsHandler | null = null;

  private readonly listeners = new Map<WsEventType, Set<WsHandler>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: WsEventType, cb: WsHandler): void {
    const set = this.listeners.get(type) ?? new Set<WsHandler>();
    set.add(cb);
    this.listeners.set(type, set);
  }

  removeEventListener(type: WsEventType, cb: WsHandler): void {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  emit(type: WsEventType, ev: unknown = {}): void {
    if (type === 'open') {
      this.readyState = MockWebSocket.OPEN;
    }
    const prop =
      type === 'open'
        ? this.onopen
        : type === 'message'
          ? this.onmessage
          : type === 'close'
            ? this.onclose
            : this.onerror;
    prop?.call(this, ev);
    for (const cb of this.listeners.get(type) ?? []) {
      cb(ev);
    }
  }
}

const HTTP_ORIGIN = 'http://collab.example:5173';
const HTTPS_ORIGIN = 'https://collab.example';

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildDocWsUrl', () => {
  it('turns an http origin into a ws:// /ws/docs url carrying the docId', () => {
    vi.stubGlobal('location', { origin: HTTP_ORIGIN });

    expect(buildDocWsUrl('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'ws://collab.example:5173/ws/docs?docId=01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
  });

  it('turns an https origin into a wss:// /ws/docs url', () => {
    vi.stubGlobal('location', { origin: HTTPS_ORIGIN });

    expect(buildDocWsUrl('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'wss://collab.example/ws/docs?docId=01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
  });

  it('URL-encodes the docId', () => {
    vi.stubGlobal('location', { origin: HTTP_ORIGIN });

    expect(buildDocWsUrl('a b&c')).toBe('ws://collab.example:5173/ws/docs?docId=a%20b%26c');
  });
});

describe('DocGatewayProvider', () => {
  it('opens a WebSocket to exactly the given url with binaryType="arraybuffer"', () => {
    const doc = new Y.Doc();
    const url = 'ws://collab.example:5173/ws/docs?docId=01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const provider = new DocGatewayProvider(url, doc);

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    expect(socket?.url).toBe(url);
    expect(socket?.binaryType).toBe('arraybuffer');

    provider.destroy();
    doc.destroy();
  });

  it('sends exactly one MESSAGE_SYNC frame when the socket opens (first varUint === 0)', () => {
    const doc = new Y.Doc();
    const provider = new DocGatewayProvider('ws://collab.example/ws/docs?docId=x', doc);
    const socket = MockWebSocket.instances[0];

    socket?.emit('open');

    expect(socket?.sent).toHaveLength(1);
    const frame = socket?.sent[0];
    expect(frame).toBeInstanceOf(Uint8Array);
    const decoder = decoding.createDecoder(frame ?? new Uint8Array());
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);

    provider.destroy();
    doc.destroy();
  });

  it('exposes an awareness (instanceof Awareness) bound to the passed doc', () => {
    const doc = new Y.Doc();
    const provider = new DocGatewayProvider('ws://collab.example/ws/docs?docId=x', doc);

    expect(provider.awareness).toBeInstanceOf(awarenessProtocol.Awareness);
    expect(provider.awareness.doc).toBe(doc);
    expect(provider.doc).toBe(doc);

    provider.destroy();
    doc.destroy();
  });

  it('closes the socket on destroy()', () => {
    const doc = new Y.Doc();
    const provider = new DocGatewayProvider('ws://collab.example/ws/docs?docId=x', doc);
    const socket = MockWebSocket.instances[0];

    provider.destroy();

    expect(socket?.close).toHaveBeenCalledTimes(1);

    doc.destroy();
  });
});
