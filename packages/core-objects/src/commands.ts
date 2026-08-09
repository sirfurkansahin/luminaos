import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { canTransition } from './lifecycle.js';
import { isKnownObjectType, requiresTitle } from './object-type-registry.js';

import type { LuminaObject, ObjectType } from './lumina-object.js';

/**
 * A draft of a domain event, not yet wrapped into the F0-T6 `NewDomainEvent`
 * envelope (that wrapping — `id`, `streamType`, `workspaceId`, `actor`,
 * `occurredAt` — is the server layer's job, per ADR-0003 "Komut -> olay ->
 * replay").
 */
export interface ObjectEventDraft {
  type: string;
  payload: Record<string, unknown>;
}

export interface CreateObjectInput {
  objectId: string;
  workspaceId: string;
  objectType: ObjectType;
  title: string;
  actor: Actor;
  causationEventId?: string;
}

function assertValidTitle(objectType: ObjectType, title: unknown): asserts title is string {
  if (typeof title !== 'string') {
    throw new ValidationError('title must be a string', { objectType });
  }

  if (requiresTitle(objectType) && title.trim() === '') {
    throw new ValidationError(`title is required for object type "${objectType}"`, {
      objectType,
    });
  }
}

/**
 * The ONLY command taking `workspaceId` (or any prior state) at all — this
 * is how `workspaceId`-immutability is enforced structurally: no other
 * command has the ability to change it because none of them accept it.
 */
export function createObject(input: CreateObjectInput): ObjectEventDraft[] {
  const objectType: string = input.objectType;

  if (!isKnownObjectType(objectType)) {
    throw new ValidationError('unknown object type', { objectType });
  }

  assertValidTitle(input.objectType, input.title);

  return [
    {
      type: 'ObjectCreated',
      payload: {
        objectId: input.objectId,
        objectType: input.objectType,
        workspaceId: input.workspaceId,
        title: input.title,
        ...(input.causationEventId !== undefined
          ? { causationEventId: input.causationEventId }
          : {}),
      },
    },
  ];
}

export function renameObject(state: LuminaObject, input: { title: string }): ObjectEventDraft[] {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError('cannot rename a deleted object', {
      objectId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'rename',
    });
  }

  assertValidTitle(state.type, input.title);

  return [
    {
      type: 'ObjectRenamed',
      payload: { objectId: state.id, title: input.title },
    },
  ];
}

export function archiveObject(state: LuminaObject): ObjectEventDraft[] {
  if (!canTransition(state.lifecycle, 'archive')) {
    throw new InvalidObjectStateError(
      `cannot archive an object in lifecycle "${state.lifecycle}"`,
      {
        objectId: state.id,
        lifecycle: state.lifecycle,
        attemptedAction: 'archive',
      },
    );
  }

  return [{ type: 'ObjectArchived', payload: { objectId: state.id } }];
}

export function restoreObject(state: LuminaObject): ObjectEventDraft[] {
  if (!canTransition(state.lifecycle, 'restore')) {
    throw new InvalidObjectStateError(
      `cannot restore an object in lifecycle "${state.lifecycle}"`,
      {
        objectId: state.id,
        lifecycle: state.lifecycle,
        attemptedAction: 'restore',
      },
    );
  }

  return [{ type: 'ObjectRestored', payload: { objectId: state.id } }];
}

export function softDeleteObject(state: LuminaObject): ObjectEventDraft[] {
  if (!canTransition(state.lifecycle, 'softDelete')) {
    throw new InvalidObjectStateError(
      `cannot soft-delete an object in lifecycle "${state.lifecycle}"`,
      { objectId: state.id, lifecycle: state.lifecycle, attemptedAction: 'softDelete' },
    );
  }

  return [{ type: 'ObjectSoftDeleted', payload: { objectId: state.id } }];
}

/**
 * Interface-only stub per ADR-0003 ("yalnızca arayüzü tanımlanır,
 * uygulanmaz"): permanent deletion is deliberately out of scope for this
 * task.
 */
export function purgeObject(state: LuminaObject): never {
  throw new InvalidObjectStateError(`purgeObject is not implemented (objectId: ${state.id})`, {
    objectId: state.id,
  });
}
