import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';

import { replayFieldValues } from './field-value-replay.js';

/**
 * `replayFieldValues(events: DomainEvent[]): Record<string, unknown>` — folds
 * ONLY FieldValueChanged events (payload.fieldKey -> payload.value), silently
 * ignoring every other event type (including ObjectCreated/ObjectRenamed/
 * etc.), because it runs on a MIXED stream that also carries F1-T1's core
 * lifecycle events (per the plan's central architecture decision: field
 * values live in the object's OWN event stream, not a separate one).
 *
 * Key contrast with replay.ts's strict discipline: an event array containing
 * only non-field events (e.g. just ObjectCreated) does NOT throw — it
 * returns {}. This is the expected/normal case, not corruption.
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
    id: `77777777-7777-4777-8777-77777777777${String(eventCounter % 10)}`,
    streamId: STREAM_ID,
    streamType: 'lumina-object',
    workspaceId: WORKSPACE_ID,
    version: eventCounter,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)),
    ...overrides,
  };
}

describe('replayFieldValues', () => {
  it('returns {} for an empty event array', () => {
    expect(replayFieldValues([])).toEqual({});
  });

  it("returns {} when the stream contains only non-field events (no throw — contrasts with replay.ts's strict discipline)", () => {
    const created = buildEvent({
      type: 'ObjectCreated',
      payload: { objectId: OBJECT_ID, objectType: 'task', workspaceId: WORKSPACE_ID, title: 'x' },
    });

    expect(replayFieldValues([created])).toEqual({});
  });

  it('folds only FieldValueChanged events from a mixed stream, skipping other event types, later value wins', () => {
    const created = buildEvent({
      type: 'ObjectCreated',
      payload: { objectId: OBJECT_ID, objectType: 'task', workspaceId: WORKSPACE_ID, title: 'x' },
    });
    const statusChanged = buildEvent({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'status', value: 'todo' },
    });
    const priorityChanged = buildEvent({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'priority', value: 'high' },
    });
    const renamed = buildEvent({
      type: 'ObjectRenamed',
      payload: { objectId: OBJECT_ID, title: 'renamed' },
    });
    const statusChangedAgain = buildEvent({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'status', value: 'done' },
    });

    const result = replayFieldValues([
      created,
      statusChanged,
      priorityChanged,
      renamed,
      statusChangedAgain,
    ]);

    expect(result).toEqual({ status: 'done', priority: 'high' });
  });

  it('(AC #5 proof, pure-domain half) has no FieldDefinition parameter at all: a recorded value replays identically regardless of any later field-definition change', () => {
    // Structural proof: the function only ever takes one parameter (the
    // event array) — there is no argument through which a FieldDefinition,
    // or a FieldUpdated event from the SEPARATE field-definition stream,
    // could ever reach this fold.
    expect(replayFieldValues.length).toBe(1);

    const statusChanged = buildEvent({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'status', value: 'a' },
    });

    // Two independent replays of the SAME already-recorded event: nothing
    // about a hypothetical later FieldUpdated (on a different stream,
    // never passed in here) can change this result.
    const firstReplay = replayFieldValues([statusChanged]);
    const secondReplay = replayFieldValues([statusChanged]);

    expect(firstReplay.status).toBe('a');
    expect(secondReplay.status).toBe('a');
    expect(secondReplay).toEqual(firstReplay);
  });
});
