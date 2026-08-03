import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent } from '@luminaos/shared';

import { isKnownObjectType } from './object-type-registry.js';

import type { ChecklistItem, Lifecycle, LuminaObject } from './lumina-object.js';

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
    checklist: [],
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
    case 'ChecklistItemAdded': {
      const { itemId, text, order } = event.payload;

      if (typeof itemId !== 'string' || itemId.length === 0) {
        throw new InvalidObjectStateError('ChecklistItemAdded event is missing a valid itemId');
      }

      if (typeof text !== 'string') {
        throw new InvalidObjectStateError('ChecklistItemAdded event is missing a valid text');
      }

      if (typeof order !== 'number') {
        throw new InvalidObjectStateError('ChecklistItemAdded event is missing a valid order');
      }

      const newItem: ChecklistItem = { id: itemId, text, done: false, order };

      return {
        ...state,
        checklist: [...state.checklist, newItem],
        updatedAt: event.occurredAt,
      };
    }
    case 'ChecklistItemToggled': {
      const { itemId, done } = event.payload;

      if (typeof itemId !== 'string' || itemId.length === 0) {
        throw new InvalidObjectStateError('ChecklistItemToggled event is missing a valid itemId');
      }

      if (typeof done !== 'boolean') {
        throw new InvalidObjectStateError('ChecklistItemToggled event is missing a valid done');
      }

      return {
        ...state,
        checklist: state.checklist.map((item) => (item.id === itemId ? { ...item, done } : item)),
        updatedAt: event.occurredAt,
      };
    }
    case 'ChecklistItemRemoved': {
      const { itemId } = event.payload;

      if (typeof itemId !== 'string' || itemId.length === 0) {
        throw new InvalidObjectStateError('ChecklistItemRemoved event is missing a valid itemId');
      }

      return {
        ...state,
        checklist: state.checklist.filter((item) => item.id !== itemId),
        updatedAt: event.occurredAt,
      };
    }
    case 'ChecklistItemReordered': {
      const { orderedItemIds } = event.payload;

      if (
        !Array.isArray(orderedItemIds) ||
        !orderedItemIds.every((id): id is string => typeof id === 'string')
      ) {
        throw new InvalidObjectStateError(
          'ChecklistItemReordered event is missing a valid orderedItemIds',
        );
      }

      const itemsById = new Map(state.checklist.map((item) => [item.id, item]));

      const reordered = orderedItemIds.map((itemId, index) => {
        const item = itemsById.get(itemId);

        if (!item) {
          throw new InvalidObjectStateError(
            'ChecklistItemReordered event references an unknown itemId',
          );
        }

        return { ...item, order: index };
      });

      return {
        ...state,
        checklist: reordered,
        updatedAt: event.occurredAt,
      };
    }
    default:
      return state;
  }
}

function withLifecycle(state: LuminaObject, lifecycle: Lifecycle, occurredAt: Date): LuminaObject {
  return { ...state, lifecycle, updatedAt: occurredAt };
}
