import { describe, expect, it } from 'vitest';

import type { DomainEvent } from './domain-event.js';
import type { Projection, ProjectionTx } from './projection.js';

/**
 * `projection.ts` is a pure structural contract (`Projection`/`ProjectionTx`
 * types, no runtime logic of its own — packages/shared stays framework-free
 * per CLAUDE.md, so `ProjectionTx` must not import Drizzle's `Database`/
 * transaction type directly; it's an intentionally opaque handle that
 * `apps/server`'s concrete projections and runner treat as the real Drizzle
 * `tx` via their own casting). These tests are kept proportional to that: (a)
 * prove a conforming object type-checks against the exported shapes, and (b)
 * lock down the `handles[]` dispatch semantics every runner built on top of
 * `Projection` relies on (`['*']` wildcard vs. exact event-type match).
 */

/** Mirrors how a runner decides whether to call `projection.apply()` for a given event type. */
function projectionHandles(projection: Projection, eventType: string): boolean {
  return projection.handles.includes('*') || projection.handles.includes(eventType);
}

function buildFakeProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    name: 'fake-projection',
    handles: ['SomethingHappened'],
    apply: (event: DomainEvent, tx: ProjectionTx): Promise<void> => {
      // no-op fake — references its params so they're not flagged as unused.
      void event;
      void tx;
      return Promise.resolve();
    },
    reset: (tx: ProjectionTx): Promise<void> => {
      // no-op fake — references its param so it's not flagged as unused.
      void tx;
      return Promise.resolve();
    },
    ...overrides,
  };
}

function buildFakeDomainEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    streamId: '22222222-2222-4222-8222-222222222222',
    streamType: 'test-stream',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    type: 'SomethingHappened',
    version: 1,
    payload: {},
    actor: { type: 'system', id: 'sys' },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Projection (structural contract)', () => {
  it('a conforming object satisfies the Projection shape (name, handles, apply, reset)', () => {
    const projection = buildFakeProjection();

    expect(projection.name).toBe('fake-projection');
    expect(projection.handles).toEqual(['SomethingHappened']);
    expect(typeof projection.apply).toBe('function');
    expect(typeof projection.reset).toBe('function');
  });

  it('apply() and reset() are callable with a (DomainEvent, ProjectionTx) / (ProjectionTx) signature and return promises', async () => {
    const projection = buildFakeProjection();
    // ProjectionTx is intentionally opaque at the packages/shared level (no
    // real Drizzle transaction available here) — a double-cast stand-in is
    // the correct way to satisfy it in a framework-free unit test.
    const tx = undefined as unknown as ProjectionTx;
    const event = buildFakeDomainEvent();

    await expect(projection.apply(event, tx)).resolves.toBeUndefined();
    await expect(projection.reset(tx)).resolves.toBeUndefined();
  });
});

describe('projectionHandles (handles[] dispatch semantics)', () => {
  it('returns true for an exact event-type match', () => {
    const projection = buildFakeProjection({ handles: ['TaskCompleted', 'TaskCreated'] });
    expect(projectionHandles(projection, 'TaskCompleted')).toBe(true);
  });

  it('returns false when the event type is not listed and there is no wildcard', () => {
    const projection = buildFakeProjection({ handles: ['TaskCompleted'] });
    expect(projectionHandles(projection, 'TaskDeleted')).toBe(false);
  });

  it("returns true for any event type when handles is ['*']", () => {
    const projection = buildFakeProjection({ handles: ['*'] });
    expect(projectionHandles(projection, 'AnyEventTypeAtAll')).toBe(true);
  });

  it('requires an exact string match — no partial/case-insensitive matching', () => {
    const projection = buildFakeProjection({ handles: ['TaskCompleted'] });
    expect(projectionHandles(projection, 'taskcompleted')).toBe(false);
    expect(projectionHandles(projection, 'TaskCompletedAgain')).toBe(false);
  });
});
