import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InProcessEventBus } from './event-bus.js';

import type { EventBus } from './event-bus.js';
import type { StoredEvent } from './event-store.service.js';

/**
 * Pure in-memory unit test — no DB/Testcontainers. Covers F0-T6 PR-B's
 * `InProcessEventBus` (per the plan, `giggly-brewing-moore.md`: built on
 * Node's `EventEmitter`, "commit sonrası best-effort hızlı yol"). The
 * critical property under test, called out explicitly by the plan, is that
 * "bir listener'ın hatası diğerlerini/publisher'ı bozmaz" — one listener's
 * error (sync throw or rejected promise) must not break other listeners or
 * propagate back to `publish()`.
 */

let globalPositionCounter = 0;

function buildStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  globalPositionCounter += 1;

  return {
    id: crypto.randomUUID(),
    streamId: crypto.randomUUID(),
    streamType: 'test-stream',
    workspaceId: crypto.randomUUID(),
    type: 'TestEventOccurred',
    version: 1,
    payload: { foo: 'bar' },
    actor: { type: 'system', id: 'test-system' },
    occurredAt: new Date(),
    globalPosition: globalPositionCounter,
    ...overrides,
  } satisfies StoredEvent;
}

describe('InProcessEventBus', () => {
  it('satisfies the EventBus interface shape (publish, subscribe)', () => {
    const bus: EventBus = new InProcessEventBus();
    expect(typeof bus.publish).toBe('function');
    expect(typeof bus.subscribe).toBe('function');
  });

  it('delivers published events to a subscribed listener, in the order published', () => {
    const bus = new InProcessEventBus();
    const receivedTypes: string[] = [];

    bus.subscribe((event) => {
      receivedTypes.push(event.type);
    });

    bus.publish([buildStoredEvent({ type: 'First' }), buildStoredEvent({ type: 'Second' })]);

    expect(receivedTypes).toEqual(['First', 'Second']);
  });

  it('delivers the same published event(s) to every subscribed listener', () => {
    const bus = new InProcessEventBus();
    const listenerA: string[] = [];
    const listenerB: string[] = [];

    bus.subscribe((event) => {
      listenerA.push(event.type);
    });
    bus.subscribe((event) => {
      listenerB.push(event.type);
    });

    const event = buildStoredEvent({ type: 'SharedEvent' });
    bus.publish([event]);

    expect(listenerA).toEqual(['SharedEvent']);
    expect(listenerB).toEqual(['SharedEvent']);
  });

  it('unsubscribing stops further delivery to that listener, but does not affect other still-subscribed listeners', () => {
    const bus = new InProcessEventBus();
    const unsubscribedListenerCalls: string[] = [];
    const stillSubscribedListenerCalls: string[] = [];

    const unsubscribe = bus.subscribe((event) => {
      unsubscribedListenerCalls.push(event.type);
    });
    bus.subscribe((event) => {
      stillSubscribedListenerCalls.push(event.type);
    });

    bus.publish([buildStoredEvent({ type: 'BeforeUnsubscribe' })]);
    unsubscribe();
    bus.publish([buildStoredEvent({ type: 'AfterUnsubscribe' })]);

    expect(unsubscribedListenerCalls).toEqual(['BeforeUnsubscribe']);
    expect(stillSubscribedListenerCalls).toEqual(['BeforeUnsubscribe', 'AfterUnsubscribe']);
  });

  it('a listener that throws synchronously does not prevent other listeners from being called, and does not propagate out of publish()', () => {
    const bus = new InProcessEventBus();
    const calls: string[] = [];

    bus.subscribe(() => {
      calls.push('throwing-listener');
      throw new Error('boom: synchronous listener failure');
    });
    bus.subscribe(() => {
      calls.push('normal-listener');
    });

    const event = buildStoredEvent({ type: 'SomeEvent' });

    expect(() => {
      bus.publish([event]);
    }).not.toThrow();

    expect(calls).toEqual(['throwing-listener', 'normal-listener']);
  });

  it('a listener whose async handler rejects does not prevent other listeners from being called, and does not reject/throw from publish()', async () => {
    const bus = new InProcessEventBus();
    const calls: string[] = [];

    bus.subscribe(async () => {
      calls.push('rejecting-listener');
      await Promise.resolve();
      throw new Error('boom: asynchronous listener rejection');
    });
    bus.subscribe(() => {
      calls.push('normal-listener');
    });

    const event = buildStoredEvent({ type: 'SomeEvent' });

    expect(() => {
      bus.publish([event]);
    }).not.toThrow();

    // Allow the rejected promise's microtask/macrotask to settle. The bus
    // must swallow this rejection internally rather than letting it become
    // an unhandled rejection that escapes `publish()`.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(calls).toEqual(['rejecting-listener', 'normal-listener']);
  });

  it('publishing with no subscribers does not throw', () => {
    const bus = new InProcessEventBus();

    expect(() => {
      bus.publish([buildStoredEvent({ type: 'NoOneListening' })]);
    }).not.toThrow();
  });

  it('publishing an empty event batch does not call any subscriber', () => {
    const bus = new InProcessEventBus();
    let callCount = 0;

    bus.subscribe(() => {
      callCount += 1;
    });

    bus.publish([]);

    expect(callCount).toBe(0);
  });
});
