import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import {
  addChecklistItem,
  removeChecklistItem,
  reorderChecklistItem,
  toggleChecklistItem,
} from './checklist-commands.js';

import type { ChecklistItem, LuminaObject } from './lumina-object.js';

/**
 * Designed command signatures (F1-T10 PR2, per the approved plan's "PR2 —
 * Gömülü ChecklistItem değer tipi" section — must be matched exactly by
 * implementer):
 *
 *   addChecklistItem(state: LuminaObject, input: { itemId: string; text: string }): ObjectEventDraft[]
 *     -> single draft, type 'ChecklistItemAdded',
 *        payload { objectId, itemId, text, order } where order is the
 *        CURRENT checklist length (appended at the end).
 *     -> throws ValidationError if `text.trim()` is empty.
 *     -> throws ValidationError with { objectId, limit: 200 } context if
 *        `state.checklist.length >= 200`.
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'
 *        (mirrors renameObject's { objectId, lifecycle, attemptedAction }
 *        shape; archived objects ARE allowed, same rule as renameObject).
 *
 *   toggleChecklistItem(state: LuminaObject, itemId: string): ObjectEventDraft[]
 *     -> single draft, type 'ChecklistItemToggled',
 *        payload { objectId, itemId, done } where done is the FLIPPED
 *        current value of the matched item (computed from state, not
 *        client-supplied).
 *     -> throws ValidationError with { objectId, itemId } context if no
 *        item in state.checklist matches itemId.
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'.
 *
 *   removeChecklistItem(state: LuminaObject, itemId: string): ObjectEventDraft[]
 *     -> single draft, type 'ChecklistItemRemoved', payload { objectId, itemId }.
 *     -> throws ValidationError with { objectId, itemId } context if no
 *        item in state.checklist matches itemId.
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'.
 *
 *   reorderChecklistItem(state: LuminaObject, orderedItemIds: string[]): ObjectEventDraft[]
 *     -> single draft, type 'ChecklistItemReordered',
 *        payload { objectId, orderedItemIds }.
 *     -> throws ValidationError with { objectId } context if
 *        orderedItemIds is not exactly a permutation of
 *        state.checklist.map(i => i.id) (missing id, extra/foreign id, or
 *        duplicate id).
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function buildState(overrides: Partial<LuminaObject> = {}): LuminaObject {
  return {
    id: OBJECT_ID,
    type: 'task',
    workspaceId: WORKSPACE_ID,
    title: 'Original title',
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    ...overrides,
  };
}

function buildItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: 'item-1',
    text: 'Buy milk',
    done: false,
    order: 0,
    ...overrides,
  };
}

describe('addChecklistItem', () => {
  it('returns a single ChecklistItemAdded draft with order = 0 for an empty checklist', () => {
    const drafts = addChecklistItem(buildState({ checklist: [] }), {
      itemId: 'item-1',
      text: 'Buy milk',
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ChecklistItemAdded');
    expect(drafts[0]?.payload).toEqual({
      objectId: OBJECT_ID,
      itemId: 'item-1',
      text: 'Buy milk',
      order: 0,
    });
  });

  it('sets order to the current checklist length when items already exist', () => {
    const existing = [buildItem({ id: 'item-1', order: 0 }), buildItem({ id: 'item-2', order: 1 })];

    const drafts = addChecklistItem(buildState({ checklist: existing }), {
      itemId: 'item-3',
      text: 'Buy eggs',
    });

    expect(drafts[0]?.payload).toMatchObject({ order: 2 });
  });

  it('throws ValidationError when text is empty', () => {
    expect(() => addChecklistItem(buildState(), { itemId: 'item-1', text: '' })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when text is whitespace-only', () => {
    expect(() => addChecklistItem(buildState(), { itemId: 'item-1', text: '   ' })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError with { objectId, limit: 200 } context at the 200-item cap', () => {
    const fullChecklist = Array.from({ length: 200 }, (_, i) =>
      buildItem({ id: `item-${String(i)}`, order: i }),
    );

    expect(() =>
      addChecklistItem(buildState({ checklist: fullChecklist }), {
        itemId: 'item-201',
        text: 'One too many',
      }),
    ).toThrow(ValidationError);

    try {
      addChecklistItem(buildState({ checklist: fullChecklist }), {
        itemId: 'item-201',
        text: 'One too many',
      });
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID, limit: 200 });
    }
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    expect(() =>
      addChecklistItem(buildState({ lifecycle: 'deleted' }), {
        itemId: 'item-1',
        text: 'Buy milk',
      }),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object (checklist edits allowed while archived, same rule as renameObject)', () => {
    expect(() =>
      addChecklistItem(buildState({ lifecycle: 'archived' }), {
        itemId: 'item-1',
        text: 'Buy milk',
      }),
    ).not.toThrow();
  });

  it('throws ValidationError when itemId already exists in the checklist', () => {
    const existing = [buildItem({ id: 'item-1' })];

    expect(() =>
      addChecklistItem(buildState({ checklist: existing }), {
        itemId: 'item-1',
        text: 'Duplicate id',
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when itemId is not a string', () => {
    expect(() =>
      addChecklistItem(buildState(), {
        itemId: 42 as unknown as string,
        text: 'Buy milk',
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when text is not a string', () => {
    expect(() =>
      addChecklistItem(buildState(), {
        itemId: 'item-1',
        text: 42 as unknown as string,
      }),
    ).toThrow(ValidationError);
  });
});

describe('toggleChecklistItem', () => {
  it('flips done from false to true and reports the flipped value in the payload', () => {
    const checklist = [buildItem({ id: 'item-1', done: false })];

    const drafts = toggleChecklistItem(buildState({ checklist }), 'item-1');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ChecklistItemToggled');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID, itemId: 'item-1', done: true });
  });

  it('flips done from true to false', () => {
    const checklist = [buildItem({ id: 'item-1', done: true })];

    const drafts = toggleChecklistItem(buildState({ checklist }), 'item-1');

    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID, itemId: 'item-1', done: false });
  });

  it('throws ValidationError with { objectId, itemId } context when itemId does not exist', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    expect(() => toggleChecklistItem(buildState({ checklist }), 'no-such-item')).toThrow(
      ValidationError,
    );

    try {
      toggleChecklistItem(buildState({ checklist }), 'no-such-item');
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({
        objectId: OBJECT_ID,
        itemId: 'no-such-item',
      });
    }
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    expect(() =>
      toggleChecklistItem(buildState({ checklist, lifecycle: 'deleted' }), 'item-1'),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    expect(() =>
      toggleChecklistItem(buildState({ checklist, lifecycle: 'archived' }), 'item-1'),
    ).not.toThrow();
  });
});

describe('removeChecklistItem', () => {
  it('returns a single ChecklistItemRemoved draft with the expected payload', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    const drafts = removeChecklistItem(buildState({ checklist }), 'item-1');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ChecklistItemRemoved');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID, itemId: 'item-1' });
  });

  it('throws ValidationError with { objectId, itemId } context when itemId does not exist', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    expect(() => removeChecklistItem(buildState({ checklist }), 'no-such-item')).toThrow(
      ValidationError,
    );

    try {
      removeChecklistItem(buildState({ checklist }), 'no-such-item');
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({
        objectId: OBJECT_ID,
        itemId: 'no-such-item',
      });
    }
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    expect(() =>
      removeChecklistItem(buildState({ checklist, lifecycle: 'deleted' }), 'item-1'),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object', () => {
    const checklist = [buildItem({ id: 'item-1' })];

    expect(() =>
      removeChecklistItem(buildState({ checklist, lifecycle: 'archived' }), 'item-1'),
    ).not.toThrow();
  });
});

describe('reorderChecklistItem', () => {
  it('returns a single ChecklistItemReordered draft with the expected payload', () => {
    const checklist = [
      buildItem({ id: 'item-1', order: 0 }),
      buildItem({ id: 'item-2', order: 1 }),
    ];

    const drafts = reorderChecklistItem(buildState({ checklist }), ['item-2', 'item-1']);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ChecklistItemReordered');
    expect(drafts[0]?.payload).toEqual({
      objectId: OBJECT_ID,
      orderedItemIds: ['item-2', 'item-1'],
    });
  });

  it('throws ValidationError when orderedItemIds is missing an existing id', () => {
    const checklist = [
      buildItem({ id: 'item-1', order: 0 }),
      buildItem({ id: 'item-2', order: 1 }),
    ];

    expect(() => reorderChecklistItem(buildState({ checklist }), ['item-1'])).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when orderedItemIds contains a foreign id not in the checklist', () => {
    const checklist = [buildItem({ id: 'item-1', order: 0 })];

    expect(() =>
      reorderChecklistItem(buildState({ checklist }), ['item-1', 'not-a-real-item']),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when orderedItemIds contains a duplicate id', () => {
    const checklist = [
      buildItem({ id: 'item-1', order: 0 }),
      buildItem({ id: 'item-2', order: 1 }),
    ];

    expect(() => reorderChecklistItem(buildState({ checklist }), ['item-1', 'item-1'])).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError with { objectId } context on an invalid permutation', () => {
    const checklist = [buildItem({ id: 'item-1', order: 0 })];

    try {
      reorderChecklistItem(buildState({ checklist }), ['not-a-real-item']);
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID });
    }
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    const checklist = [
      buildItem({ id: 'item-1', order: 0 }),
      buildItem({ id: 'item-2', order: 1 }),
    ];

    expect(() =>
      reorderChecklistItem(buildState({ checklist, lifecycle: 'deleted' }), ['item-2', 'item-1']),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object', () => {
    const checklist = [
      buildItem({ id: 'item-1', order: 0 }),
      buildItem({ id: 'item-2', order: 1 }),
    ];

    expect(() =>
      reorderChecklistItem(buildState({ checklist, lifecycle: 'archived' }), ['item-2', 'item-1']),
    ).not.toThrow();
  });
});
