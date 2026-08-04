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

describe('replayObject: checklist events', () => {
  it('applies ChecklistItemAdded: appends a checklist item and bumps updatedAt', () => {
    const created = createdEvent();
    const added = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 'Buy milk', order: 0 },
    });

    const result = replayObject([created, added]);

    expect(result.checklist).toEqual([{ id: 'item-1', text: 'Buy milk', done: false, order: 0 }]);
    expect(result.updatedAt).toEqual(added.occurredAt);
  });

  it('throws when ChecklistItemAdded has an invalid itemId', () => {
    const created = createdEvent();
    const added = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: '', text: 'Buy milk', order: 0 },
    });

    expect(() => replayObject([created, added])).toThrow(InvalidObjectStateError);
  });

  it('throws when ChecklistItemAdded has an invalid text', () => {
    const created = createdEvent();
    const added = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 42, order: 0 },
    });

    expect(() => replayObject([created, added])).toThrow(InvalidObjectStateError);
  });

  it('throws when ChecklistItemAdded has an invalid order', () => {
    const created = createdEvent();
    const added = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 'Buy milk', order: 'zero' },
    });

    expect(() => replayObject([created, added])).toThrow(InvalidObjectStateError);
  });

  it('applies ChecklistItemToggled: flips the matched item, leaves others untouched', () => {
    const created = createdEvent();
    const added1 = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 'Buy milk', order: 0 },
    });
    const added2 = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-2', text: 'Buy eggs', order: 1 },
    });
    const toggled = buildEvent({
      type: 'ChecklistItemToggled',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', done: true },
    });

    const result = replayObject([created, added1, added2, toggled]);

    expect(result.checklist).toEqual([
      { id: 'item-1', text: 'Buy milk', done: true, order: 0 },
      { id: 'item-2', text: 'Buy eggs', done: false, order: 1 },
    ]);
    expect(result.updatedAt).toEqual(toggled.occurredAt);
  });

  it('throws when ChecklistItemToggled has an invalid itemId', () => {
    const created = createdEvent();
    const toggled = buildEvent({
      type: 'ChecklistItemToggled',
      payload: { objectId: OBJECT_ID, itemId: '', done: true },
    });

    expect(() => replayObject([created, toggled])).toThrow(InvalidObjectStateError);
  });

  it('throws when ChecklistItemToggled has an invalid done', () => {
    const created = createdEvent();
    const toggled = buildEvent({
      type: 'ChecklistItemToggled',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', done: 'yes' },
    });

    expect(() => replayObject([created, toggled])).toThrow(InvalidObjectStateError);
  });

  it('applies ChecklistItemRemoved: drops the matched item', () => {
    const created = createdEvent();
    const added1 = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 'Buy milk', order: 0 },
    });
    const added2 = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-2', text: 'Buy eggs', order: 1 },
    });
    const removed = buildEvent({
      type: 'ChecklistItemRemoved',
      payload: { objectId: OBJECT_ID, itemId: 'item-1' },
    });

    const result = replayObject([created, added1, added2, removed]);

    expect(result.checklist).toEqual([{ id: 'item-2', text: 'Buy eggs', done: false, order: 1 }]);
    expect(result.updatedAt).toEqual(removed.occurredAt);
  });

  it('throws when ChecklistItemRemoved has an invalid itemId', () => {
    const created = createdEvent();
    const removed = buildEvent({
      type: 'ChecklistItemRemoved',
      payload: { objectId: OBJECT_ID, itemId: '' },
    });

    expect(() => replayObject([created, removed])).toThrow(InvalidObjectStateError);
  });

  it('applies ChecklistItemReordered: resequences order to match the new array position', () => {
    const created = createdEvent();
    const added1 = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 'Buy milk', order: 0 },
    });
    const added2 = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-2', text: 'Buy eggs', order: 1 },
    });
    const reordered = buildEvent({
      type: 'ChecklistItemReordered',
      payload: { objectId: OBJECT_ID, orderedItemIds: ['item-2', 'item-1'] },
    });

    const result = replayObject([created, added1, added2, reordered]);

    expect(result.checklist).toEqual([
      { id: 'item-2', text: 'Buy eggs', done: false, order: 0 },
      { id: 'item-1', text: 'Buy milk', done: false, order: 1 },
    ]);
    expect(result.updatedAt).toEqual(reordered.occurredAt);
  });

  it('throws when ChecklistItemReordered has an invalid orderedItemIds', () => {
    const created = createdEvent();
    const reordered = buildEvent({
      type: 'ChecklistItemReordered',
      payload: { objectId: OBJECT_ID, orderedItemIds: 'not-an-array' },
    });

    expect(() => replayObject([created, reordered])).toThrow(InvalidObjectStateError);
  });

  it('throws when ChecklistItemReordered references an unknown itemId', () => {
    const created = createdEvent();
    const added = buildEvent({
      type: 'ChecklistItemAdded',
      payload: { objectId: OBJECT_ID, itemId: 'item-1', text: 'Buy milk', order: 0 },
    });
    const reordered = buildEvent({
      type: 'ChecklistItemReordered',
      payload: { objectId: OBJECT_ID, orderedItemIds: ['not-a-real-item'] },
    });

    expect(() => replayObject([created, added, reordered])).toThrow(InvalidObjectStateError);
  });
});

/**
 * F1-T10 PR4 (RED step) — `recurrenceRule` replay folding, the other half of
 * `./recurrence-rule-commands.test.ts`'s pinned contract (see that file's
 * header for the full "why an embedded LuminaObject field, not a Custom
 * Field" design-decision writeup). `LuminaObject` does not have a
 * `recurrenceRule` field yet, so EVERY `result.recurrenceRule` access below
 * is expected to fail TypeScript compilation ("Property 'recurrenceRule'
 * does not exist on type 'LuminaObject'") — `implementer` must add
 * `recurrenceRule?: RecurrenceRule` to `./lumina-object.ts`'s `LuminaObject`
 * interface (plus the `RecurrenceRule` type itself) and fold
 * `RecurrenceRuleSet`/`RecurrenceRuleCleared` in `./replay.ts`'s
 * `applyEvent` to turn this green.
 */
describe('replayObject: recurrence rule events', () => {
  it('recurrenceRule is undefined by default after ObjectCreated (no recurrence set yet)', () => {
    const created = createdEvent();

    const result = replayObject([created]);

    expect(result.recurrenceRule).toBeUndefined();
  });

  it('applies RecurrenceRuleSet: sets recurrenceRule (all fields) and bumps updatedAt', () => {
    const created = createdEvent();
    const set = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: {
        objectId: OBJECT_ID,
        frequency: 'weekly',
        interval: 2,
        byWeekday: [1, 3, 5],
        endDate: '2026-12-31',
      },
    });

    const result = replayObject([created, set]);

    expect(result.recurrenceRule).toEqual({
      frequency: 'weekly',
      interval: 2,
      byWeekday: [1, 3, 5],
      endDate: '2026-12-31',
    });
    expect(result.updatedAt).toEqual(set.occurredAt);
  });

  it('applies RecurrenceRuleSet with only the required fields (no byWeekday/endDate)', () => {
    const created = createdEvent();
    const set = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: { objectId: OBJECT_ID, frequency: 'daily', interval: 1 },
    });

    const result = replayObject([created, set]);

    expect(result.recurrenceRule).toEqual({ frequency: 'daily', interval: 1 });
  });

  it('a later RecurrenceRuleSet replaces the earlier one entirely', () => {
    const created = createdEvent();
    const firstSet = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: { objectId: OBJECT_ID, frequency: 'daily', interval: 1, byWeekday: [1] },
    });
    const secondSet = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: { objectId: OBJECT_ID, frequency: 'monthly', interval: 3 },
    });

    const result = replayObject([created, firstSet, secondSet]);

    expect(result.recurrenceRule).toEqual({ frequency: 'monthly', interval: 3 });
  });

  it('throws when RecurrenceRuleSet has an invalid frequency', () => {
    const created = createdEvent();
    const set = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: { objectId: OBJECT_ID, frequency: 'yearly', interval: 1 },
    });

    expect(() => replayObject([created, set])).toThrow(InvalidObjectStateError);
  });

  it('throws when RecurrenceRuleSet has an invalid interval', () => {
    const created = createdEvent();
    const set = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: { objectId: OBJECT_ID, frequency: 'daily', interval: 'two' },
    });

    expect(() => replayObject([created, set])).toThrow(InvalidObjectStateError);
  });

  it('applies RecurrenceRuleCleared: clears recurrenceRule back to undefined and bumps updatedAt', () => {
    const created = createdEvent();
    const set = buildEvent({
      type: 'RecurrenceRuleSet',
      payload: { objectId: OBJECT_ID, frequency: 'daily', interval: 1 },
    });
    const cleared = buildEvent({
      type: 'RecurrenceRuleCleared',
      payload: { objectId: OBJECT_ID },
    });

    const result = replayObject([created, set, cleared]);

    expect(result.recurrenceRule).toBeUndefined();
    expect(result.updatedAt).toEqual(cleared.occurredAt);
  });
});
