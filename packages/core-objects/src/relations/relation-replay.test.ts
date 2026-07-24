import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { replayRelation } from './relation-replay.js';

/**
 * `replayRelation(events: DomainEvent[]): Relation` — a pure fold mirroring
 * replay.ts's / field-replay.ts's discipline: the stream must start with
 * RelationCreated (else InvalidObjectStateError), every payload field it
 * reads is validated (typeof / known-RelationKind guards) rather than
 * trusted blindly (F1-T1 PR-A security-review hardening, repeated here for
 * F1-T3 — see field-replay.test.ts's precedent), and an unrecognized event
 * type after the first is a no-op (forward compatibility, same as
 * replayObject's / replayFieldDefinition's `default: return state` branch).
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '55555555-5555-4555-8555-555555555555';
const RELATION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

let eventCounter = 0;

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
): DomainEvent {
  eventCounter += 1;
  return {
    id: `77777777-7777-4777-8777-77777777777${String(eventCounter % 10)}`,
    streamId: STREAM_ID,
    streamType: 'relation',
    workspaceId: WORKSPACE_ID,
    version: eventCounter,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)),
    ...overrides,
  };
}

function createdEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return buildEvent({
    type: 'RelationCreated',
    payload: {
      relationId: RELATION_ID,
      workspaceId: WORKSPACE_ID,
      fromId: 'obj-a',
      toId: 'obj-b',
      kind: 'reference',
    },
    ...overrides,
  });
}

describe('replayRelation', () => {
  it('throws when given an empty event array', () => {
    expect(() => replayRelation([])).toThrow(InvalidObjectStateError);
  });

  it('throws when the first event is not RelationCreated', () => {
    const notCreated = buildEvent({
      type: 'RelationRemoved',
      payload: { relationId: RELATION_ID },
    });

    expect(() => replayRelation([notCreated])).toThrow(InvalidObjectStateError);
  });

  it('folds a single RelationCreated into an active Relation', () => {
    const created = createdEvent();

    const result = replayRelation([created]);

    expect(result.id).toBe(RELATION_ID);
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.fromId).toBe('obj-a');
    expect(result.toId).toBe('obj-b');
    expect(result.kind).toBe('reference');
    expect(result.status).toBe('active');
    expect(result.createdAt).toEqual(created.occurredAt);
    expect(result.updatedAt).toEqual(created.occurredAt);
  });

  it('folds RelationCreated with a parentChild kind', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-parent',
        toId: 'obj-child',
        kind: 'parentChild',
      },
    });

    const result = replayRelation([created]);

    expect(result.kind).toBe('parentChild');
    expect(result.fromId).toBe('obj-parent');
    expect(result.toId).toBe('obj-child');
  });

  it('folds RelationCreated with a dependency kind', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-blocker',
        toId: 'obj-blocked',
        kind: 'dependency',
      },
    });

    const result = replayRelation([created]);

    expect(result.kind).toBe('dependency');
  });

  it('applies RelationRemoved: status becomes removed and updatedAt bumps from the RelationRemoved event', () => {
    const created = createdEvent();
    const removed = buildEvent({
      type: 'RelationRemoved',
      payload: { relationId: RELATION_ID },
    });

    const result = replayRelation([created, removed]);

    expect(result.status).toBe('removed');
    expect(result.updatedAt).toEqual(removed.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('skips an unrecognized event type as a no-op (forward compatibility)', () => {
    const created = createdEvent();
    const unknown = buildEvent({
      type: 'SomeFutureEvent',
      payload: { relationId: RELATION_ID },
    });

    const result = replayRelation([created, unknown]);

    expect(result.status).toBe('active');
    expect(result.fromId).toBe('obj-a');
    expect(result.updatedAt).toEqual(created.occurredAt);
  });
});

describe('replayRelation rejects a corrupted RelationCreated payload (mirrors field-replay.test.ts)', () => {
  it('throws when relationId is missing', () => {
    const created = createdEvent({
      payload: {
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        toId: 'obj-b',
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when relationId is wrong-typed', () => {
    const created = createdEvent({
      payload: {
        relationId: 12345,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        toId: 'obj-b',
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when workspaceId is missing', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        fromId: 'obj-a',
        toId: 'obj-b',
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when fromId is missing', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        toId: 'obj-b',
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when fromId is wrong-typed', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 42,
        toId: 'obj-b',
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when toId is missing', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when toId is wrong-typed', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        toId: [],
        kind: 'reference',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when kind is missing', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        toId: 'obj-b',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when kind is not a known RelationKind', () => {
    const created = createdEvent({
      payload: {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        toId: 'obj-b',
        kind: 'not-a-real-kind',
      },
    });

    expect(() => replayRelation([created])).toThrow(InvalidObjectStateError);
  });
});

describe('replayRelation rejects a corrupted RelationRemoved payload', () => {
  it('throws when relationId is missing', () => {
    const created = createdEvent();
    const removed = buildEvent({ type: 'RelationRemoved', payload: {} });

    expect(() => replayRelation([created, removed])).toThrow(InvalidObjectStateError);
  });

  it('throws when relationId is wrong-typed', () => {
    const created = createdEvent();
    const removed = buildEvent({ type: 'RelationRemoved', payload: { relationId: 999 } });

    expect(() => replayRelation([created, removed])).toThrow(InvalidObjectStateError);
  });
});
