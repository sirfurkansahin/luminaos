import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { replayObject } from './replay.js';

/**
 * Regression tests from F1-T1 PR-A security review (Finding 2): `payload`
 * on `DomainEvent` is `z.record(z.string(), z.unknown())` — the F0-T6
 * event store never validates its contents. Today `commands.ts::
 * createObject` is the only writer and always produces a well-formed
 * payload, but `replayObject` must not silently trust that forever: a
 * corrupted/unknown `objectType`, or a missing `objectId`/`title`, must
 * raise `InvalidObjectStateError` at replay time rather than either
 * crashing later (`undefined.titleRequired`) or silently coercing into the
 * literal string `"undefined"`.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
): DomainEvent {
  return {
    id: '33333333-3333-4333-8333-333333333330',
    streamId: STREAM_ID,
    streamType: 'lumina-object',
    workspaceId: WORKSPACE_ID,
    version: 1,
    actor: ACTOR,
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('replayObject rejects a corrupted ObjectCreated payload', () => {
  it('throws when objectType is not a known object type', () => {
    const created = buildEvent({
      type: 'ObjectCreated',
      payload: { objectId: OBJECT_ID, objectType: 'not-a-real-type', title: 'x' },
    });

    expect(() => replayObject([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when objectId is missing', () => {
    const created = buildEvent({
      type: 'ObjectCreated',
      payload: { objectType: 'task', title: 'x' },
    });

    expect(() => replayObject([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when title is missing', () => {
    const created = buildEvent({
      type: 'ObjectCreated',
      payload: { objectId: OBJECT_ID, objectType: 'task' },
    });

    expect(() => replayObject([created])).toThrow(InvalidObjectStateError);
  });
});

describe('replayObject rejects a corrupted ObjectRenamed payload', () => {
  it('throws when title is missing', () => {
    const created = buildEvent({
      type: 'ObjectCreated',
      payload: { objectId: OBJECT_ID, objectType: 'task', title: 'Original' },
    });
    const renamed = buildEvent({
      type: 'ObjectRenamed',
      version: 2,
      payload: { objectId: OBJECT_ID },
    });

    expect(() => replayObject([created, renamed])).toThrow(InvalidObjectStateError);
  });
});
