import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent } from '@luminaos/shared';

import { isKnownObjectType } from './object-type-registry.js';

import type { Lifecycle, LuminaObject } from './lumina-object.js';

/**
 * Per ADR-0003 "Komut -> olay -> replay": a pure fold, no wall clock /
 * randomness / IO. Trusts the array order it is given (does not re-sort by
 * `version`/`occurredAt`) — the caller (`EventStoreService.readStream`)
 * already returns events ordered by `version` ascending.
 */
export function replayObject(events: DomainEvent[]): LuminaObject {
  const [first, ...rest] = events;

  if (!first || first.type !== 'ObjectCreated') {
    throw new InvalidObjectStateError('a Lumina Object event stream must start with ObjectCreated');
  }

  let state = applyObjectCreated(first);

  for (const event of rest) {
    state = applyEvent(state, event);
  }

  return state;
}

function applyObjectCreated(event: DomainEvent): LuminaObject {
  const { objectId, objectType, title } = event.payload;

  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new InvalidObjectStateError('ObjectCreated event is missing a valid objectId');
  }

  if (typeof objectType !== 'string' || !isKnownObjectType(objectType)) {
    throw new InvalidObjectStateError('ObjectCreated event has an invalid or unknown objectType');
  }

  if (typeof title !== 'string') {
    throw new InvalidObjectStateError('ObjectCreated event is missing a valid title');
  }

  return {
    id: objectId,
    type: objectType,
    workspaceId: event.workspaceId,
    title,
    createdBy: event.actor.id,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    lifecycle: 'active',
  };
}

function applyEvent(state: LuminaObject, event: DomainEvent): LuminaObject {
  switch (event.type) {
    case 'ObjectRenamed': {
      const { title } = event.payload;

      if (typeof title !== 'string') {
        throw new InvalidObjectStateError('ObjectRenamed event is missing a valid title');
      }

      return {
        ...state,
        title,
        updatedAt: event.occurredAt,
      };
    }
    case 'ObjectArchived':
      return withLifecycle(state, 'archived', event.occurredAt);
    case 'ObjectRestored':
      return withLifecycle(state, 'active', event.occurredAt);
    case 'ObjectSoftDeleted':
      return withLifecycle(state, 'deleted', event.occurredAt);
    default:
      return state;
  }
}

function withLifecycle(state: LuminaObject, lifecycle: Lifecycle, occurredAt: Date): LuminaObject {
  return { ...state, lifecycle, updatedAt: occurredAt };
}
