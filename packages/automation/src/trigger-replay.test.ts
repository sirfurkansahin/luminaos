import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { replayTrigger } from './trigger-replay.js';

/**
 * F2-T15 PR1 (RED step) — `replayTrigger(events: DomainEvent[]): Trigger`, a
 * pure fold mirroring `replaySavedView`'s discipline (ADR-0032 Karar i/l):
 * the stream must start with `TriggerCreated` (else
 * `InvalidObjectStateError`), every payload field it reads is validated
 * (`typeof` / known-kind guards) rather than trusted blindly, and an
 * unrecognized event type after the first is a no-op (forward
 * compatibility, same as `replaySavedView`'s `default: return state`
 * branch).
 *
 * Folds:
 *   - `TriggerCreated` -> full initial state: { id, workspaceId, name, kind,
 *     spec, lastFiredAt: null, lifecycle: 'active', createdAt, updatedAt }.
 *   - `TriggerUpdated` -> merges ONLY the keys present in the payload
 *     (name/spec), bumps `updatedAt`. If `spec` is present, `kind` is
 *     re-derived from `spec.kind`.
 *   - `TriggerDeleted` -> `lifecycle: 'deleted'`, bumps `updatedAt`.
 *
 * EXPECTED LINT STATE (today, mirrors `./meeting-details.integration.test.ts`'s
 * documented convention): a single isolated `import-x/no-unresolved` finding
 * at the `./trigger-replay.js` import, plus its natural
 * `@typescript-eslint/no-unsafe-*` cascade — clears once `implementer` adds
 * the real source file.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '66666666-6666-4666-8666-666666666666';
const TRIGGER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBX';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

const SCHEDULE_SPEC = {
  kind: 'scheduled',
  intervalMinutes: 60,
  actionTemplate: { title: 'Weekly review' },
};

const CONDITION_SPEC = {
  kind: 'condition',
  objectType: 'task',
  fieldKey: 'title',
  pattern: '^INV-\\d{4}$',
  flags: '',
  actionTemplate: { title: 'Follow up on invoice' },
};

let eventCounter = 0;

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
): DomainEvent {
  eventCounter += 1;
  return {
    id: `88888888-8888-4888-8888-88888888888${String(eventCounter % 10)}`,
    streamId: STREAM_ID,
    streamType: 'trigger',
    workspaceId: WORKSPACE_ID,
    version: eventCounter,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)),
    ...overrides,
  };
}

function createdEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return buildEvent({
    type: 'TriggerCreated',
    payload: {
      triggerId: TRIGGER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'My trigger',
      kind: 'scheduled',
      spec: SCHEDULE_SPEC,
    },
    ...overrides,
  });
}

describe('replayTrigger', () => {
  it('throws when given an empty event array', () => {
    expect(() => replayTrigger([])).toThrow(InvalidObjectStateError);
  });

  it('throws when the first event is not TriggerCreated', () => {
    const notCreated = buildEvent({
      type: 'TriggerDeleted',
      payload: { triggerId: TRIGGER_ID },
    });

    expect(() => replayTrigger([notCreated])).toThrow(InvalidObjectStateError);
  });

  it('folds a single scheduled TriggerCreated into an active Trigger', () => {
    const created = createdEvent();

    const result = replayTrigger([created]);

    expect(result.id).toBe(TRIGGER_ID);
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.name).toBe('My trigger');
    expect(result.kind).toBe('scheduled');
    expect(result.spec).toEqual(SCHEDULE_SPEC);
    expect(result.lastFiredAt).toBeNull();
    expect(result.lifecycle).toBe('active');
    expect(result.createdAt).toEqual(created.occurredAt);
    expect(result.updatedAt).toEqual(created.occurredAt);
  });

  it('folds a condition TriggerCreated, correctly reconstructing the discriminated kind/spec shape', () => {
    const created = createdEvent({
      payload: {
        triggerId: TRIGGER_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Regex watcher',
        kind: 'condition',
        spec: CONDITION_SPEC,
      },
    });

    const result = replayTrigger([created]);

    expect(result.kind).toBe('condition');
    expect(result.spec).toEqual(CONDITION_SPEC);
    if (result.spec.kind === 'condition') {
      expect(result.spec.objectType).toBe('task');
      expect(result.spec.fieldKey).toBe('title');
      expect(result.spec.pattern).toBe('^INV-\\d{4}$');
    } else {
      throw new Error('expected a condition spec');
    }
  });

  it('applies TriggerUpdated: merges only the payload keys present, bumps updatedAt', () => {
    const created = createdEvent();
    const updated = buildEvent({
      type: 'TriggerUpdated',
      payload: { triggerId: TRIGGER_ID, name: 'Renamed' },
    });

    const result = replayTrigger([created, updated]);

    expect(result.name).toBe('Renamed');
    expect(result.spec).toEqual(SCHEDULE_SPEC);
    expect(result.updatedAt).toEqual(updated.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('applies a TriggerUpdated changing spec', () => {
    const created = createdEvent();
    const newSpec = { ...SCHEDULE_SPEC, intervalMinutes: 15 };
    const updated = buildEvent({
      type: 'TriggerUpdated',
      payload: { triggerId: TRIGGER_ID, spec: newSpec },
    });

    const result = replayTrigger([created, updated]);

    expect(result.spec).toEqual(newSpec);
    expect(result.name).toBe('My trigger');
  });

  it('applies TriggerDeleted: lifecycle becomes deleted and updatedAt bumps', () => {
    const created = createdEvent();
    const deleted = buildEvent({
      type: 'TriggerDeleted',
      payload: { triggerId: TRIGGER_ID },
    });

    const result = replayTrigger([created, deleted]);

    expect(result.lifecycle).toBe('deleted');
    expect(result.updatedAt).toEqual(deleted.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('skips an unrecognized event type as a no-op (forward compatibility)', () => {
    const created = createdEvent();
    const unknown = buildEvent({
      type: 'SomeFutureEvent',
      payload: { triggerId: TRIGGER_ID },
    });

    const result = replayTrigger([created, unknown]);

    expect(result.lifecycle).toBe('active');
    expect(result.name).toBe('My trigger');
    expect(result.updatedAt).toEqual(created.occurredAt);
  });
});

describe('replayTrigger rejects a corrupted TriggerCreated payload', () => {
  it('throws when triggerId is missing', () => {
    const created = createdEvent({
      payload: {
        workspaceId: WORKSPACE_ID,
        name: 'My trigger',
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
      },
    });

    expect(() => replayTrigger([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when workspaceId is missing', () => {
    const created = createdEvent({
      payload: {
        triggerId: TRIGGER_ID,
        name: 'My trigger',
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
      },
    });

    expect(() => replayTrigger([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when name is missing', () => {
    const created = createdEvent({
      payload: {
        triggerId: TRIGGER_ID,
        workspaceId: WORKSPACE_ID,
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
      },
    });

    expect(() => replayTrigger([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when kind is an unknown value', () => {
    const created = createdEvent({
      payload: {
        triggerId: TRIGGER_ID,
        workspaceId: WORKSPACE_ID,
        name: 'My trigger',
        kind: 'not-a-real-kind',
        spec: SCHEDULE_SPEC,
      },
    });

    expect(() => replayTrigger([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when spec is missing', () => {
    const created = createdEvent({
      payload: {
        triggerId: TRIGGER_ID,
        workspaceId: WORKSPACE_ID,
        name: 'My trigger',
        kind: 'scheduled',
      },
    });

    expect(() => replayTrigger([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when spec is not an object (wrong-typed)', () => {
    const created = createdEvent({
      payload: {
        triggerId: TRIGGER_ID,
        workspaceId: WORKSPACE_ID,
        name: 'My trigger',
        kind: 'scheduled',
        spec: 'not-an-object',
      },
    });

    expect(() => replayTrigger([created])).toThrow(InvalidObjectStateError);
  });
});

describe('replayTrigger rejects a corrupted TriggerUpdated payload', () => {
  it('throws when triggerId is missing', () => {
    const created = createdEvent();
    const updated = buildEvent({ type: 'TriggerUpdated', payload: { name: 'x' } });

    expect(() => replayTrigger([created, updated])).toThrow(InvalidObjectStateError);
  });
});

describe('replayTrigger rejects a corrupted TriggerDeleted payload', () => {
  it('throws when triggerId is missing', () => {
    const created = createdEvent();
    const deleted = buildEvent({ type: 'TriggerDeleted', payload: {} });

    expect(() => replayTrigger([created, deleted])).toThrow(InvalidObjectStateError);
  });
});
