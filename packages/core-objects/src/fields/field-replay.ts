import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent } from '@luminaos/shared';

import { isKnownObjectType } from '../object-type-registry.js';
import { isValidFieldPermissions } from './field-permissions.js';
import { isKnownFieldType } from './field-type-registry.js';

import type { FieldDefinition } from './field-definition.js';

/**
 * Per F1-T2 plan (PR-A): a pure fold mirroring `replay.ts`'s discipline —
 * the stream must start with `FieldDefined`, and every payload field it
 * reads is validated (`typeof`/`isKnownFieldType`/`isKnownObjectType`/
 * `isValidFieldPermissions` guards) rather than trusted blindly (F1-T1 PR-A
 * security-review hardening, repeated here). An unrecognized event type
 * after the first is a no-op (forward compatibility, same as
 * `replayObject`'s `default: return state` branch).
 */
export function replayFieldDefinition(events: DomainEvent[]): FieldDefinition {
  const [first, ...rest] = events;

  if (!first || first.type !== 'FieldDefined') {
    throw new InvalidObjectStateError(
      'a field-definition event stream must start with FieldDefined',
    );
  }

  let state = applyFieldDefined(first);

  for (const event of rest) {
    state = applyEvent(state, event);
  }

  return state;
}

function applyFieldDefined(event: DomainEvent): FieldDefinition {
  const { fieldDefinitionId, workspaceId, objectType, key, label, fieldType, config, permissions } =
    event.payload;

  if (typeof fieldDefinitionId !== 'string' || fieldDefinitionId.length === 0) {
    throw new InvalidObjectStateError('FieldDefined event is missing a valid fieldDefinitionId');
  }

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new InvalidObjectStateError('FieldDefined event is missing a valid workspaceId');
  }

  if (typeof objectType !== 'string' || !isKnownObjectType(objectType)) {
    throw new InvalidObjectStateError('FieldDefined event has an invalid or unknown objectType');
  }

  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidObjectStateError('FieldDefined event is missing a valid key');
  }

  if (typeof label !== 'string') {
    throw new InvalidObjectStateError('FieldDefined event is missing a valid label');
  }

  if (typeof fieldType !== 'string' || !isKnownFieldType(fieldType)) {
    throw new InvalidObjectStateError('FieldDefined event has an invalid or unknown fieldType');
  }

  if (!isValidFieldPermissions(permissions)) {
    throw new InvalidObjectStateError('FieldDefined event has invalid permissions');
  }

  return {
    id: fieldDefinitionId,
    workspaceId,
    objectType,
    key,
    label,
    fieldType,
    config,
    defaultValue: event.payload.defaultValue,
    permissions,
    lifecycle: 'active',
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

function applyEvent(state: FieldDefinition, event: DomainEvent): FieldDefinition {
  switch (event.type) {
    case 'FieldUpdated':
      return applyFieldUpdated(state, event);
    case 'FieldArchived':
      return { ...state, lifecycle: 'archived', updatedAt: event.occurredAt };
    default:
      return state;
  }
}

function applyFieldUpdated(state: FieldDefinition, event: DomainEvent): FieldDefinition {
  const { fieldDefinitionId, label, config, defaultValue, permissions } = event.payload;

  if (typeof fieldDefinitionId !== 'string' || fieldDefinitionId.length === 0) {
    throw new InvalidObjectStateError('FieldUpdated event is missing a valid fieldDefinitionId');
  }

  let next = state;

  if (label !== undefined) {
    if (typeof label !== 'string') {
      throw new InvalidObjectStateError('FieldUpdated event has an invalid label');
    }
    next = { ...next, label };
  }

  if (config !== undefined) {
    next = { ...next, config };
  }

  if (defaultValue !== undefined) {
    next = { ...next, defaultValue };
  }

  if (permissions !== undefined) {
    if (!isValidFieldPermissions(permissions)) {
      throw new InvalidObjectStateError('FieldUpdated event has invalid permissions');
    }
    next = { ...next, permissions };
  }

  return { ...next, updatedAt: event.occurredAt };
}
