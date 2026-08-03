import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import type { ObjectEventDraft } from './commands.js';
import type { LuminaObject } from './lumina-object.js';

const CHECKLIST_ITEM_LIMIT = 200;

function assertNotDeleted(state: LuminaObject, attemptedAction: string): void {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError(`cannot ${attemptedAction} on a deleted object`, {
      objectId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction,
    });
  }
}

function findChecklistItem(state: LuminaObject, itemId: string) {
  const item = state.checklist.find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new ValidationError('no checklist item found for the given itemId', {
      objectId: state.id,
      itemId,
    });
  }

  return item;
}

export function addChecklistItem(
  state: LuminaObject,
  input: { itemId: string; text: string },
): ObjectEventDraft[] {
  assertNotDeleted(state, 'addChecklistItem');

  if (typeof input.itemId !== 'string' || input.itemId.trim() === '') {
    throw new ValidationError('checklist item itemId must be a non-empty string', {
      objectId: state.id,
    });
  }

  if (typeof input.text !== 'string' || input.text.trim() === '') {
    throw new ValidationError('checklist item text must not be empty', {
      objectId: state.id,
    });
  }

  if (state.checklist.some((item) => item.id === input.itemId)) {
    throw new ValidationError('a checklist item with this itemId already exists', {
      objectId: state.id,
      itemId: input.itemId,
    });
  }

  if (state.checklist.length >= CHECKLIST_ITEM_LIMIT) {
    throw new ValidationError('checklist item limit reached', {
      objectId: state.id,
      limit: CHECKLIST_ITEM_LIMIT,
    });
  }

  return [
    {
      type: 'ChecklistItemAdded',
      payload: {
        objectId: state.id,
        itemId: input.itemId,
        text: input.text,
        order: state.checklist.length,
      },
    },
  ];
}

export function toggleChecklistItem(state: LuminaObject, itemId: string): ObjectEventDraft[] {
  assertNotDeleted(state, 'toggleChecklistItem');

  const item = findChecklistItem(state, itemId);

  return [
    {
      type: 'ChecklistItemToggled',
      payload: { objectId: state.id, itemId, done: !item.done },
    },
  ];
}

export function removeChecklistItem(state: LuminaObject, itemId: string): ObjectEventDraft[] {
  assertNotDeleted(state, 'removeChecklistItem');

  findChecklistItem(state, itemId);

  return [
    {
      type: 'ChecklistItemRemoved',
      payload: { objectId: state.id, itemId },
    },
  ];
}

export function reorderChecklistItem(
  state: LuminaObject,
  orderedItemIds: string[],
): ObjectEventDraft[] {
  assertNotDeleted(state, 'reorderChecklistItem');

  const existingIds = state.checklist.map((item) => item.id);

  const isValidPermutation =
    orderedItemIds.length === existingIds.length &&
    new Set(orderedItemIds).size === orderedItemIds.length &&
    orderedItemIds.every((id) => existingIds.includes(id));

  if (!isValidPermutation) {
    throw new ValidationError(
      'orderedItemIds must be exactly a permutation of the existing checklist item ids',
      { objectId: state.id },
    );
  }

  return [
    {
      type: 'ChecklistItemReordered',
      payload: { objectId: state.id, orderedItemIds },
    },
  ];
}
