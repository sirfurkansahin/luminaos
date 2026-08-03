import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { replaySavedView } from './saved-view-replay.js';

/**
 * `replaySavedView(events: DomainEvent[]): SavedView` — a pure fold mirroring
 * `replayRelation`'s / `replayFieldDefinition`'s discipline: the stream must
 * start with `SavedViewCreated` (else `InvalidObjectStateError`), every
 * payload field it reads is validated (`typeof` / known-`ViewType` guards)
 * rather than trusted blindly (F1-T1 PR-A security-review hardening, repeated
 * here per this task's instructions), and an unrecognized event type after
 * the first is a no-op (forward compatibility, same as `replayRelation`'s /
 * `replayFieldDefinition`'s `default: return state` branch).
 *
 * Folds:
 *   - `SavedViewCreated` -> full initial state, `lifecycle: 'active'`.
 *   - `SavedViewUpdated` -> merges ONLY the keys present in the payload
 *     (name/icon/querySpec/dateField/startField/endField), bumps `updatedAt`.
 *   - `SavedViewDeleted` -> `lifecycle: 'deleted'`, bumps `updatedAt`.
 *
 * `ownerId` is `string | null` — `null` is a valid, EXPECTED value (a shared
 * view), not a corrupted-payload condition; only a non-string/non-null value
 * is rejected.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '66666666-6666-4666-8666-666666666666';
const SAVED_VIEW_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBX';
const OWNER_ID = 'user-owner-1';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

const BASE_QUERY_SPEC = { objectType: 'task', filters: [] };

let eventCounter = 0;

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
): DomainEvent {
  eventCounter += 1;
  return {
    id: `88888888-8888-4888-8888-88888888888${String(eventCounter % 10)}`,
    streamId: STREAM_ID,
    streamType: 'saved-view',
    workspaceId: WORKSPACE_ID,
    version: eventCounter,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)),
    ...overrides,
  };
}

function createdEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return buildEvent({
    type: 'SavedViewCreated',
    payload: {
      savedViewId: SAVED_VIEW_ID,
      workspaceId: WORKSPACE_ID,
      objectType: 'task',
      name: 'Urgent this week',
      icon: 'flame',
      viewType: 'list',
      querySpec: BASE_QUERY_SPEC,
      ownerId: OWNER_ID,
    },
    ...overrides,
  });
}

describe('replaySavedView', () => {
  it('throws when given an empty event array', () => {
    expect(() => replaySavedView([])).toThrow(InvalidObjectStateError);
  });

  it('throws when the first event is not SavedViewCreated', () => {
    const notCreated = buildEvent({
      type: 'SavedViewDeleted',
      payload: { savedViewId: SAVED_VIEW_ID },
    });

    expect(() => replaySavedView([notCreated])).toThrow(InvalidObjectStateError);
  });

  it('folds a single SavedViewCreated into an active SavedView', () => {
    const created = createdEvent();

    const result = replaySavedView([created]);

    expect(result.id).toBe(SAVED_VIEW_ID);
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.objectType).toBe('task');
    expect(result.name).toBe('Urgent this week');
    expect(result.icon).toBe('flame');
    expect(result.viewType).toBe('list');
    expect(result.querySpec).toEqual(BASE_QUERY_SPEC);
    expect(result.ownerId).toBe(OWNER_ID);
    expect(result.lifecycle).toBe('active');
    expect(result.createdAt).toEqual(created.occurredAt);
    expect(result.updatedAt).toEqual(created.occurredAt);
  });

  it('folds a shared SavedViewCreated (ownerId: null) correctly', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Shared view',
        icon: 'star',
        viewType: 'board',
        querySpec: BASE_QUERY_SPEC,
        ownerId: null,
      },
    });

    const result = replaySavedView([created]);

    expect(result.ownerId).toBeNull();
  });

  it('folds a calendar SavedViewCreated carrying dateField', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Calendar view',
        icon: 'calendar',
        viewType: 'calendar',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
        dateField: 'dueDate',
      },
    });

    const result = replaySavedView([created]);

    expect(result.viewType).toBe('calendar');
    expect(result.dateField).toBe('dueDate');
    expect(result.startField).toBeUndefined();
    expect(result.endField).toBeUndefined();
  });

  it('folds a timeline SavedViewCreated carrying startField/endField', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Timeline view',
        icon: 'clock',
        viewType: 'timeline',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
        startField: 'startDate',
        endField: 'endDate',
      },
    });

    const result = replaySavedView([created]);

    expect(result.viewType).toBe('timeline');
    expect(result.startField).toBe('startDate');
    expect(result.endField).toBe('endDate');
    expect(result.dateField).toBeUndefined();
  });

  it('applies SavedViewUpdated: merges only the payload keys present, bumps updatedAt', () => {
    const created = createdEvent();
    const updated = buildEvent({
      type: 'SavedViewUpdated',
      payload: { savedViewId: SAVED_VIEW_ID, name: 'Renamed' },
    });

    const result = replaySavedView([created, updated]);

    expect(result.name).toBe('Renamed');
    // Untouched fields survive the partial update.
    expect(result.icon).toBe('flame');
    expect(result.querySpec).toEqual(BASE_QUERY_SPEC);
    expect(result.updatedAt).toEqual(updated.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('applies a SavedViewUpdated changing querySpec', () => {
    const created = createdEvent();
    const newQuerySpec = {
      objectType: 'task',
      filters: [{ field: 'priority', operator: 'equals', value: 'high' }],
    };
    const updated = buildEvent({
      type: 'SavedViewUpdated',
      payload: { savedViewId: SAVED_VIEW_ID, querySpec: newQuerySpec },
    });

    const result = replaySavedView([created, updated]);

    expect(result.querySpec).toEqual(newQuerySpec);
    expect(result.name).toBe('Urgent this week');
  });

  it('applies a SavedViewUpdated changing dateField', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Calendar view',
        icon: 'calendar',
        viewType: 'calendar',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
        dateField: 'dueDate',
      },
    });
    const updated = buildEvent({
      type: 'SavedViewUpdated',
      payload: { savedViewId: SAVED_VIEW_ID, dateField: 'completedDate' },
    });

    const result = replaySavedView([created, updated]);

    expect(result.dateField).toBe('completedDate');
  });

  it('applies SavedViewDeleted: lifecycle becomes deleted and updatedAt bumps', () => {
    const created = createdEvent();
    const deleted = buildEvent({
      type: 'SavedViewDeleted',
      payload: { savedViewId: SAVED_VIEW_ID },
    });

    const result = replaySavedView([created, deleted]);

    expect(result.lifecycle).toBe('deleted');
    expect(result.updatedAt).toEqual(deleted.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('skips an unrecognized event type as a no-op (forward compatibility)', () => {
    const created = createdEvent();
    const unknown = buildEvent({
      type: 'SomeFutureEvent',
      payload: { savedViewId: SAVED_VIEW_ID },
    });

    const result = replaySavedView([created, unknown]);

    expect(result.lifecycle).toBe('active');
    expect(result.name).toBe('Urgent this week');
    expect(result.updatedAt).toEqual(created.occurredAt);
  });
});

describe('replaySavedView rejects a corrupted SavedViewCreated payload', () => {
  it('throws when savedViewId is missing', () => {
    const created = createdEvent({
      payload: {
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when savedViewId is wrong-typed', () => {
    const created = createdEvent({
      payload: {
        savedViewId: 12345,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when workspaceId is missing', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when objectType is missing', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when name is missing', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when icon is missing', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when viewType is not a known ViewType', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'not-a-real-view-type',
        querySpec: BASE_QUERY_SPEC,
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when querySpec is missing', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when querySpec is not an object (wrong-typed)', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: 'not-an-object',
        ownerId: OWNER_ID,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when ownerId is neither a string nor null (e.g. a number)', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: 42,
      },
    });

    expect(() => replaySavedView([created])).toThrow(InvalidObjectStateError);
  });

  it('does NOT throw when ownerId is null (a valid shared-view value, not corruption)', () => {
    const created = createdEvent({
      payload: {
        savedViewId: SAVED_VIEW_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        name: 'Urgent this week',
        icon: 'flame',
        viewType: 'list',
        querySpec: BASE_QUERY_SPEC,
        ownerId: null,
      },
    });

    expect(() => replaySavedView([created])).not.toThrow();
  });
});

describe('replaySavedView rejects a corrupted SavedViewUpdated payload', () => {
  it('throws when savedViewId is missing', () => {
    const created = createdEvent();
    const updated = buildEvent({ type: 'SavedViewUpdated', payload: { name: 'x' } });

    expect(() => replaySavedView([created, updated])).toThrow(InvalidObjectStateError);
  });
});

describe('replaySavedView rejects a corrupted SavedViewDeleted payload', () => {
  it('throws when savedViewId is missing', () => {
    const created = createdEvent();
    const deleted = buildEvent({ type: 'SavedViewDeleted', payload: {} });

    expect(() => replaySavedView([created, deleted])).toThrow(InvalidObjectStateError);
  });
});
