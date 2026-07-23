import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';

import { replayObject } from './replay.js';

/**
 * Covers `replayObject`'s forward-compatibility no-op branch: an event type
 * this fold does not (yet) recognize is skipped rather than throwing, so
 * that future event types (upcasters notwithstanding, per
 * `domain-event.ts`'s "payload evolution... via read-side upcasters" note)
 * do not break existing replay consumers.
 */
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
  version: number,
): DomainEvent {
  return {
    id: `55555555-5555-4555-8555-55555555555${String(version % 10)}`,
    streamId: STREAM_ID,
    streamType: 'lumina-object',
    workspaceId: WORKSPACE_ID,
    version,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, version)),
    ...overrides,
  };
}

describe('replayObject: unrecognized event type', () => {
  it('is skipped as a no-op, leaving state (including updatedAt) unchanged', () => {
    const created = buildEvent(
      {
        type: 'ObjectCreated',
        payload: {
          objectId: OBJECT_ID,
          objectType: 'task',
          workspaceId: WORKSPACE_ID,
          title: 'Title',
        },
      },
      1,
    );
    const unknown = buildEvent({ type: 'SomeFutureEvent', payload: { objectId: OBJECT_ID } }, 2);

    const result = replayObject([created, unknown]);

    expect(result.title).toBe('Title');
    expect(result.lifecycle).toBe('active');
    expect(result.updatedAt).toEqual(created.occurredAt);
  });
});
