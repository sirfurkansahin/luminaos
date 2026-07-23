import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { replayObject } from './replay.js';

/**
 * `replayObject(events: DomainEvent[]): LuminaObject` — a pure fold, no wall
 * clock / randomness / IO. Per ADR-0003 ("Komut -> olay -> replay"):
 * `createdBy` = the ObjectCreated event's `actor.id`; `createdAt` and
 * `updatedAt` are event `occurredAt` timestamps (not `new Date()` at replay
 * time); `workspaceId` on the resulting LuminaObject comes from the event
 * ENVELOPE (`event.workspaceId`), not from the payload, even though
 * `createObject`'s payload also happens to carry a `workspaceId` for the
 * read-side projection's convenience.
 *
 * Ordering assumption (documented for implementer): `replayObject` trusts
 * the array order it is given and does NOT re-sort by `version`/
 * `occurredAt`. The caller (`EventStoreService.readStream`) already returns
 * events ordered by `version` ascending — re-sorting here would be
 * redundant and would hide a caller bug instead of surfacing it.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

let eventCounter = 0;

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
): DomainEvent {
  eventCounter += 1;
  return {
    id: `33333333-3333-4333-8333-33333333333${String(eventCounter % 10)}`,
    streamId: STREAM_ID,
    streamType: 'lumina-object',
    workspaceId: WORKSPACE_ID,
    version: eventCounter,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)),
    ...overrides,
  };
}

function createdEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return buildEvent({
    type: 'ObjectCreated',
    payload: {
      objectId: OBJECT_ID,
      objectType: 'task',
      workspaceId: WORKSPACE_ID,
      title: 'Original title',
    },
    ...overrides,
  });
}

describe('replayObject', () => {
  it('throws when given an empty event array (a stream must start with ObjectCreated)', () => {
    expect(() => replayObject([])).toThrow(InvalidObjectStateError);
  });

  it('throws when the first event is not ObjectCreated', () => {
    const notCreated = buildEvent({
      type: 'ObjectRenamed',
      payload: { objectId: OBJECT_ID, title: 'x' },
    });

    expect(() => replayObject([notCreated])).toThrow(InvalidObjectStateError);
  });

  it('folds a single ObjectCreated into an active LuminaObject', () => {
    const created = createdEvent();

    const result = replayObject([created]);

    expect(result.id).toBe(OBJECT_ID);
    expect(result.type).toBe('task');
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.title).toBe('Original title');
    expect(result.lifecycle).toBe('active');
    expect(result.createdBy).toBe(ACTOR.id);
    expect(result.createdAt).toEqual(created.occurredAt);
    expect(result.updatedAt).toEqual(created.occurredAt);
  });

  it('takes workspaceId from the event envelope, not from the payload', () => {
    const created = createdEvent({
      workspaceId: WORKSPACE_ID,
      payload: {
        objectId: OBJECT_ID,
        objectType: 'task',
        // Deliberately mismatched to prove replay does not trust payload.workspaceId.
        workspaceId: '99999999-9999-4999-8999-999999999999',
        title: 'Original title',
      },
    });

    const result = replayObject([created]);

    expect(result.workspaceId).toBe(WORKSPACE_ID);
  });

  it('applies ObjectRenamed: updates title and updatedAt, leaves createdAt unchanged', () => {
    const created = createdEvent();
    const renamed = buildEvent({
      type: 'ObjectRenamed',
      payload: { objectId: OBJECT_ID, title: 'Renamed title' },
    });

    const result = replayObject([created, renamed]);

    expect(result.title).toBe('Renamed title');
    expect(result.updatedAt).toEqual(renamed.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('applies ObjectArchived: lifecycle becomes archived', () => {
    const created = createdEvent();
    const archived = buildEvent({ type: 'ObjectArchived', payload: { objectId: OBJECT_ID } });

    const result = replayObject([created, archived]);

    expect(result.lifecycle).toBe('archived');
  });

  it('applies ObjectArchived then ObjectRestored: lifecycle returns to active', () => {
    const created = createdEvent();
    const archived = buildEvent({ type: 'ObjectArchived', payload: { objectId: OBJECT_ID } });
    const restored = buildEvent({ type: 'ObjectRestored', payload: { objectId: OBJECT_ID } });

    const result = replayObject([created, archived, restored]);

    expect(result.lifecycle).toBe('active');
  });

  it('applies ObjectSoftDeleted: lifecycle becomes deleted', () => {
    const created = createdEvent();
    const softDeleted = buildEvent({
      type: 'ObjectSoftDeleted',
      payload: { objectId: OBJECT_ID },
    });

    const result = replayObject([created, softDeleted]);

    expect(result.lifecycle).toBe('deleted');
  });

  it('applies ObjectSoftDeleted then ObjectRestored: lifecycle returns to active (restore-from-deleted)', () => {
    const created = createdEvent();
    const softDeleted = buildEvent({
      type: 'ObjectSoftDeleted',
      payload: { objectId: OBJECT_ID },
    });
    const restored = buildEvent({ type: 'ObjectRestored', payload: { objectId: OBJECT_ID } });

    const result = replayObject([created, softDeleted, restored]);

    expect(result.lifecycle).toBe('active');
  });

  it('bumps updatedAt on every subsequent event but never touches createdAt/createdBy/id/workspaceId/type', () => {
    const created = createdEvent();
    const archived = buildEvent({ type: 'ObjectArchived', payload: { objectId: OBJECT_ID } });
    const restored = buildEvent({ type: 'ObjectRestored', payload: { objectId: OBJECT_ID } });

    const result = replayObject([created, archived, restored]);

    expect(result.id).toBe(OBJECT_ID);
    expect(result.type).toBe('task');
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.createdBy).toBe(ACTOR.id);
    expect(result.createdAt).toEqual(created.occurredAt);
    expect(result.updatedAt).toEqual(restored.occurredAt);
  });
});
