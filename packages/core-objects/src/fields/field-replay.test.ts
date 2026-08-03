import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { replayFieldDefinition } from './field-replay.js';

import type { FieldPermissions } from './field-permissions.js';

/**
 * `replayFieldDefinition(events: DomainEvent[]): FieldDefinition` — a pure
 * fold mirroring replay.ts's discipline: the stream must start with
 * FieldDefined (else InvalidObjectStateError), every payload field it reads
 * is validated (typeof / isKnownFieldType / isKnownObjectType guards) rather
 * than trusted blindly (F1-T1 PR-A security-review hardening, repeated
 * here — see replay-corrupted-event.test.ts's precedent), and an
 * unrecognized event type after the first is a no-op (forward
 * compatibility, same as replayObject's `default: return state` branch).
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STREAM_ID = '44444444-4444-4444-8444-444444444444';
const FIELD_DEFINITION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ACTOR: Actor = { type: 'user', id: 'user-1' };

const VALID_PERMISSIONS: FieldPermissions = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'view',
};

let eventCounter = 0;

function buildEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'payload'>,
): DomainEvent {
  eventCounter += 1;
  return {
    id: `66666666-6666-4666-8666-66666666666${String(eventCounter % 10)}`,
    streamId: STREAM_ID,
    streamType: 'field-definition',
    workspaceId: WORKSPACE_ID,
    version: eventCounter,
    actor: ACTOR,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)),
    ...overrides,
  };
}

function definedEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return buildEvent({
    type: 'FieldDefined',
    payload: {
      fieldDefinitionId: FIELD_DEFINITION_ID,
      workspaceId: WORKSPACE_ID,
      objectType: 'task',
      key: 'status',
      label: 'Status',
      fieldType: 'select',
      config: {
        options: [
          { value: 'todo', label: 'Todo' },
          { value: 'done', label: 'Done' },
        ],
      },
      permissions: VALID_PERMISSIONS,
    },
    ...overrides,
  });
}

describe('replayFieldDefinition', () => {
  it('throws when given an empty event array', () => {
    expect(() => replayFieldDefinition([])).toThrow(InvalidObjectStateError);
  });

  it('throws when the first event is not FieldDefined', () => {
    const notDefined = buildEvent({
      type: 'FieldUpdated',
      payload: { fieldDefinitionId: FIELD_DEFINITION_ID, label: 'x' },
    });

    expect(() => replayFieldDefinition([notDefined])).toThrow(InvalidObjectStateError);
  });

  it('folds a single FieldDefined into an active FieldDefinition', () => {
    const created = definedEvent();

    const result = replayFieldDefinition([created]);

    expect(result.id).toBe(FIELD_DEFINITION_ID);
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.objectType).toBe('task');
    expect(result.key).toBe('status');
    expect(result.label).toBe('Status');
    expect(result.fieldType).toBe('select');
    expect(result.config).toEqual({
      options: [
        { value: 'todo', label: 'Todo' },
        { value: 'done', label: 'Done' },
      ],
    });
    expect(result.permissions).toEqual(VALID_PERMISSIONS);
    expect(result.lifecycle).toBe('active');
    expect(result.createdAt).toEqual(created.occurredAt);
    expect(result.updatedAt).toEqual(created.occurredAt);
  });

  it('applies FieldUpdated: updates only the fields present in the payload, bumps updatedAt', () => {
    const created = definedEvent();
    const updated = buildEvent({
      type: 'FieldUpdated',
      payload: { fieldDefinitionId: FIELD_DEFINITION_ID, label: 'New label' },
    });

    const result = replayFieldDefinition([created, updated]);

    expect(result.label).toBe('New label');
    // Untouched fields survive the partial update.
    expect(result.config).toEqual({
      options: [
        { value: 'todo', label: 'Todo' },
        { value: 'done', label: 'Done' },
      ],
    });
    expect(result.permissions).toEqual(VALID_PERMISSIONS);
    expect(result.updatedAt).toEqual(updated.occurredAt);
    expect(result.createdAt).toEqual(created.occurredAt);
  });

  it('applies a FieldUpdated changing config', () => {
    const created = definedEvent();
    const updated = buildEvent({
      type: 'FieldUpdated',
      payload: {
        fieldDefinitionId: FIELD_DEFINITION_ID,
        config: {
          options: [
            { value: 'todo', label: 'Todo' },
            { value: 'in-progress', label: 'In progress' },
            { value: 'done', label: 'Done' },
          ],
        },
      },
    });

    const result = replayFieldDefinition([created, updated]);

    expect(result.config).toEqual({
      options: [
        { value: 'todo', label: 'Todo' },
        { value: 'in-progress', label: 'In progress' },
        { value: 'done', label: 'Done' },
      ],
    });
    expect(result.label).toBe('Status');
  });

  it('applies a FieldUpdated changing defaultValue', () => {
    const created = definedEvent();
    const updated = buildEvent({
      type: 'FieldUpdated',
      payload: { fieldDefinitionId: FIELD_DEFINITION_ID, defaultValue: 'done' },
    });

    const result = replayFieldDefinition([created, updated]);

    expect(result.defaultValue).toBe('done');
  });

  it('applies a FieldUpdated changing permissions', () => {
    const created = definedEvent();
    const newPermissions: FieldPermissions = {
      owner: 'edit',
      admin: 'edit',
      member: 'hidden',
      guest: 'hidden',
    };
    const updated = buildEvent({
      type: 'FieldUpdated',
      payload: { fieldDefinitionId: FIELD_DEFINITION_ID, permissions: newPermissions },
    });

    const result = replayFieldDefinition([created, updated]);

    expect(result.permissions).toEqual(newPermissions);
  });

  it('applies FieldArchived: lifecycle becomes archived and updatedAt bumps', () => {
    const created = definedEvent();
    const archived = buildEvent({
      type: 'FieldArchived',
      payload: { fieldDefinitionId: FIELD_DEFINITION_ID },
    });

    const result = replayFieldDefinition([created, archived]);

    expect(result.lifecycle).toBe('archived');
    expect(result.updatedAt).toEqual(archived.occurredAt);
  });

  it('skips an unrecognized event type as a no-op (forward compatibility)', () => {
    const created = definedEvent();
    const unknown = buildEvent({
      type: 'SomeFutureEvent',
      payload: { fieldDefinitionId: FIELD_DEFINITION_ID },
    });

    const result = replayFieldDefinition([created, unknown]);

    expect(result.label).toBe('Status');
    expect(result.updatedAt).toEqual(created.occurredAt);
  });
});

describe('replayFieldDefinition rejects a corrupted FieldDefined payload (mirrors replay-corrupted-event.test.ts)', () => {
  it('throws when fieldDefinitionId is missing', () => {
    const created = definedEvent({
      payload: {
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        key: 'status',
        label: 'Status',
        fieldType: 'select',
        config: { options: ['a'] },
        permissions: VALID_PERMISSIONS,
      },
    });

    expect(() => replayFieldDefinition([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when objectType is not a known object type', () => {
    const created = definedEvent({
      payload: {
        fieldDefinitionId: FIELD_DEFINITION_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'not-a-real-type',
        key: 'status',
        label: 'Status',
        fieldType: 'select',
        config: { options: ['a'] },
        permissions: VALID_PERMISSIONS,
      },
    });

    expect(() => replayFieldDefinition([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when fieldType is not a known field type', () => {
    const created = definedEvent({
      payload: {
        fieldDefinitionId: FIELD_DEFINITION_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        key: 'status',
        label: 'Status',
        fieldType: 'not-a-real-field-type',
        config: {},
        permissions: VALID_PERMISSIONS,
      },
    });

    expect(() => replayFieldDefinition([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when key is missing', () => {
    const created = definedEvent({
      payload: {
        fieldDefinitionId: FIELD_DEFINITION_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        label: 'Status',
        fieldType: 'select',
        config: { options: ['a'] },
        permissions: VALID_PERMISSIONS,
      },
    });

    expect(() => replayFieldDefinition([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when label is missing', () => {
    const created = definedEvent({
      payload: {
        fieldDefinitionId: FIELD_DEFINITION_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        key: 'status',
        fieldType: 'select',
        config: { options: ['a'] },
        permissions: VALID_PERMISSIONS,
      },
    });

    expect(() => replayFieldDefinition([created])).toThrow(InvalidObjectStateError);
  });

  it('throws when permissions does not cover all 4 roles', () => {
    const incompletePermissions = { owner: 'edit', admin: 'edit', member: 'edit' };
    const created = definedEvent({
      payload: {
        fieldDefinitionId: FIELD_DEFINITION_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        key: 'status',
        label: 'Status',
        fieldType: 'select',
        config: { options: ['a'] },
        permissions: incompletePermissions,
      },
    });

    expect(() => replayFieldDefinition([created])).toThrow(InvalidObjectStateError);
  });
});

describe('replayFieldDefinition rejects a corrupted FieldUpdated payload', () => {
  it('throws when fieldDefinitionId is missing', () => {
    const created = definedEvent();
    const updated = buildEvent({ type: 'FieldUpdated', payload: { label: 'x' } });

    expect(() => replayFieldDefinition([created, updated])).toThrow(InvalidObjectStateError);
  });
});
