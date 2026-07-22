import { EventEmitter } from 'node:events';

import { Logger } from '@nestjs/common';

import type { StoredEvent } from './event-store.service.js';

/** A subscriber callback; may return `void` or a `Promise<void>` (async listeners are supported). */
export type EventBusListener = (event: StoredEvent) => void | Promise<void>;

/**
 * The event store's publish/subscribe surface. Per F0-T6's plan
 * (`giggly-brewing-moore.md`): "ayrı outbox tablosu yok — günlüğün kendisi
 * zaten dayanıklı outbox rolünü görüyor" — this bus is a best-effort,
 * commit-after fast path, not the durability guarantee (that's
 * `ProjectionRunner`'s checkpoint-based catch-up). This interface exists so a
 * future external queue implementation can be swapped in without touching
 * callers.
 */
export interface EventBus {
  /** Publishes a batch of already-persisted events to every current subscriber, in order. */
  publish(events: StoredEvent[]): void;
  /** Registers a listener; returns a function that unsubscribes it. */
  subscribe(listener: EventBusListener): () => void;
}

const CHANNEL = 'event';

/**
 * In-process `EventBus` built on Node's built-in `EventEmitter` (no new
 * dependency). A listener that throws synchronously, or whose returned
 * promise rejects, must never break another listener or escape `publish()`
 * — each listener invocation is isolated and any failure is only logged
 * (never the event's `payload`/`actor`, per CLAUDE.md's "kullanıcı verisini
 * ... log'a yazma" rule — only the event `type` is included).
 */
export class InProcessEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger(InProcessEventBus.name);

  constructor() {
    // Domain projections/handlers may legitimately outnumber Node's default
    // max-listener warning threshold (10); this bus is meant to fan out to
    // an arbitrary number of subscribers.
    this.emitter.setMaxListeners(0);
  }

  publish(events: StoredEvent[]): void {
    for (const event of events) {
      this.emitter.emit(CHANNEL, event);
    }
  }

  subscribe(listener: EventBusListener): () => void {
    const safeListener = (event: StoredEvent): void => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.logRejection(event, error);
          });
        }
      } catch (error) {
        this.logRejection(event, error);
      }
    };

    this.emitter.on(CHANNEL, safeListener);

    return () => {
      this.emitter.off(CHANNEL, safeListener);
    };
  }

  private logRejection(event: StoredEvent, error: unknown): void {
    this.logger.error(
      `In-process event bus listener failed for event type "${event.type}".`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
