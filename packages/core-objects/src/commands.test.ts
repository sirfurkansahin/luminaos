import { describe, expect, it } from 'vitest';

import { AppError, InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import {
  archiveObject,
  createObject,
  purgeObject,
  renameObject,
  restoreObject,
  softDeleteObject,
} from './commands.js';

import type { Lifecycle, LuminaObject, ObjectType } from './lumina-object.js';

/**
 * Designed command signatures (must be matched exactly by implementer):
 *
 *   createObject(input: {
 *     objectId: string; workspaceId: string; objectType: ObjectType;
 *     title: string; actor: Actor;
 *   }): ObjectEventDraft[]
 *     -> single draft, type 'ObjectCreated',
 *        payload { objectId, objectType, workspaceId, title }
 *     -> throws ValidationError if objectType is unknown, or if the type
 *        requires a title and `title` is empty/whitespace-only.
 *     -> the ONLY command taking workspaceId (or any prior state) at all —
 *        this is how workspaceId-immutability is enforced structurally.
 *
 *   renameObject(state: LuminaObject, input: { title: string }): ObjectEventDraft[]
 *     -> single draft, type 'ObjectRenamed', payload { objectId, title }
 *     -> throws ValidationError if the object's type requires a title and
 *        the new title is empty/whitespace-only.
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'.
 *
 *   archiveObject(state: LuminaObject): ObjectEventDraft[]
 *     -> single draft, type 'ObjectArchived', payload { objectId }
 *     -> throws InvalidObjectStateError unless state.lifecycle === 'active'.
 *
 *   restoreObject(state: LuminaObject): ObjectEventDraft[]
 *     -> single draft, type 'ObjectRestored', payload { objectId }
 *     -> throws InvalidObjectStateError unless state.lifecycle is
 *        'archived' or 'deleted'.
 *
 *   softDeleteObject(state: LuminaObject): ObjectEventDraft[]
 *     -> single draft, type 'ObjectSoftDeleted', payload { objectId }
 *     -> throws InvalidObjectStateError unless state.lifecycle is
 *        'active' or 'archived'.
 *
 *   purgeObject(state: LuminaObject): never
 *     -> interface-only stub per ADR-0003 ("yalnızca arayüzü tanımlanır,
 *        uygulanmaz"): exists as an exported function, always throws an
 *        AppError-derived "not implemented" error. No real contract tested.
 *
 * `ObjectEventDraft = { type: string; payload: Record<string, unknown> }`.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR = { type: 'user', id: 'user-1' } as const;

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

describe('createObject', () => {
  it('returns a single ObjectCreated draft with the expected payload', () => {
    const drafts = createObject({
      objectId: OBJECT_ID,
      workspaceId: WORKSPACE_ID,
      objectType: 'task',
      title: 'Write the ADR',
      actor: ACTOR,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ObjectCreated');
    expect(drafts[0]?.payload).toMatchObject({
      objectId: OBJECT_ID,
      objectType: 'task',
      workspaceId: WORKSPACE_ID,
      title: 'Write the ADR',
    });
  });

  it('allows an empty title for a type that does not require one (doc)', () => {
    expect(() =>
      createObject({
        objectId: OBJECT_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'doc',
        title: '',
        actor: ACTOR,
      }),
    ).not.toThrow();
  });

  it('allows an empty title for a type that does not require one (note)', () => {
    expect(() =>
      createObject({
        objectId: OBJECT_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'note',
        title: '',
        actor: ACTOR,
      }),
    ).not.toThrow();
  });

  it('throws ValidationError when the type requires a title and none is given', () => {
    expect(() =>
      createObject({
        objectId: OBJECT_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        title: '',
        actor: ACTOR,
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when the required title is whitespace-only', () => {
    expect(() =>
      createObject({
        objectId: OBJECT_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'task',
        title: '   ',
        actor: ACTOR,
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError for an unknown object type', () => {
    expect(() =>
      createObject({
        objectId: OBJECT_ID,
        workspaceId: WORKSPACE_ID,
        objectType: 'project' as ObjectType,
        title: 'Whatever',
        actor: ACTOR,
      }),
    ).toThrow(ValidationError);
  });
});

describe('renameObject', () => {
  it('returns a single ObjectRenamed draft with the expected payload', () => {
    const drafts = renameObject(buildState(), { title: 'New title' });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ObjectRenamed');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID, title: 'New title' });
  });

  it('does not carry a workspaceId in its payload (workspaceId is immutable)', () => {
    const drafts = renameObject(buildState(), { title: 'New title' });
    expect(drafts[0]?.payload).not.toHaveProperty('workspaceId');
  });

  it('throws ValidationError when the type requires a title and the new one is empty', () => {
    expect(() => renameObject(buildState({ type: 'task' }), { title: '' })).toThrow(
      ValidationError,
    );
  });

  it('allows an empty new title for a type that does not require one', () => {
    expect(() =>
      renameObject(buildState({ type: 'doc', title: 'x' }), { title: '' }),
    ).not.toThrow();
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    expect(() =>
      renameObject(buildState({ lifecycle: 'deleted' }), { title: 'New title' }),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an active object', () => {
    expect(() =>
      renameObject(buildState({ lifecycle: 'active' }), { title: 'New title' }),
    ).not.toThrow();
  });

  it('succeeds on an archived object', () => {
    expect(() =>
      renameObject(buildState({ lifecycle: 'archived' }), { title: 'New title' }),
    ).not.toThrow();
  });
});

describe('archiveObject', () => {
  it('returns a single ObjectArchived draft with the expected payload', () => {
    const drafts = archiveObject(buildState({ lifecycle: 'active' }));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ObjectArchived');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID });
  });

  it('succeeds from active', () => {
    expect(() => archiveObject(buildState({ lifecycle: 'active' }))).not.toThrow();
  });

  it('throws InvalidObjectStateError from archived', () => {
    expect(() => archiveObject(buildState({ lifecycle: 'archived' }))).toThrow(
      InvalidObjectStateError,
    );
  });

  it('throws InvalidObjectStateError from deleted', () => {
    expect(() => archiveObject(buildState({ lifecycle: 'deleted' }))).toThrow(
      InvalidObjectStateError,
    );
  });
});

describe('restoreObject', () => {
  it('returns a single ObjectRestored draft with the expected payload', () => {
    const drafts = restoreObject(buildState({ lifecycle: 'archived' }));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ObjectRestored');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID });
  });

  it('succeeds from archived', () => {
    expect(() => restoreObject(buildState({ lifecycle: 'archived' }))).not.toThrow();
  });

  it('succeeds from deleted (restore-from-deleted is explicitly required)', () => {
    expect(() => restoreObject(buildState({ lifecycle: 'deleted' }))).not.toThrow();
  });

  it('throws InvalidObjectStateError from active', () => {
    expect(() => restoreObject(buildState({ lifecycle: 'active' }))).toThrow(
      InvalidObjectStateError,
    );
  });
});

describe('softDeleteObject', () => {
  it('returns a single ObjectSoftDeleted draft with the expected payload', () => {
    const drafts = softDeleteObject(buildState({ lifecycle: 'active' }));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('ObjectSoftDeleted');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID });
  });

  it('succeeds from active', () => {
    expect(() => softDeleteObject(buildState({ lifecycle: 'active' }))).not.toThrow();
  });

  it('succeeds from archived', () => {
    expect(() => softDeleteObject(buildState({ lifecycle: 'archived' }))).not.toThrow();
  });

  it('throws InvalidObjectStateError from deleted', () => {
    expect(() => softDeleteObject(buildState({ lifecycle: 'deleted' }))).toThrow(
      InvalidObjectStateError,
    );
  });
});

describe('purgeObject (interface-only stub, per ADR-0003)', () => {
  it('is exported as a function', () => {
    expect(typeof purgeObject).toBe('function');
  });

  it('throws a clear "not implemented" AppError when called, rather than doing anything', () => {
    const state = buildState({ lifecycle: 'deleted' });
    expect(() => purgeObject(state)).toThrow(AppError);
    expect(() => purgeObject(state)).toThrow(/not implemented/i);
  });
});

describe('deleted object rejects every command except restore (AC #3)', () => {
  const deletedState = buildState({ lifecycle: 'deleted' });

  it('renameObject throws InvalidObjectStateError', () => {
    expect(() => renameObject(deletedState, { title: 'x' })).toThrow(InvalidObjectStateError);
  });

  it('archiveObject throws InvalidObjectStateError', () => {
    expect(() => archiveObject(deletedState)).toThrow(InvalidObjectStateError);
  });

  it('softDeleteObject throws InvalidObjectStateError', () => {
    expect(() => softDeleteObject(deletedState)).toThrow(InvalidObjectStateError);
  });

  it('restoreObject succeeds', () => {
    expect(() => restoreObject(deletedState)).not.toThrow();
  });
});

describe('commands work again after a restore (AC #3)', () => {
  // Full replay-level restoration is replay.test.ts's job; here we exercise
  // command functions directly against a state shaped as-if restore had
  // just happened (lifecycle: 'active').
  const postRestoreState = buildState({ lifecycle: 'active' });

  it('renameObject succeeds', () => {
    expect(() => renameObject(postRestoreState, { title: 'post-restore title' })).not.toThrow();
  });

  it('archiveObject succeeds', () => {
    expect(() => archiveObject(postRestoreState)).not.toThrow();
  });

  it('softDeleteObject succeeds', () => {
    expect(() => softDeleteObject(postRestoreState)).not.toThrow();
  });
});

describe('workspaceId immutability invariant', () => {
  it('renameObject payload has no workspaceId key', () => {
    const [draft] = renameObject(buildState(), { title: 'x' });
    expect(draft?.payload.workspaceId).toBeUndefined();
  });

  it('archiveObject payload has no workspaceId key', () => {
    const [draft] = archiveObject(buildState({ lifecycle: 'active' }));
    expect(draft?.payload.workspaceId).toBeUndefined();
  });

  it('restoreObject payload has no workspaceId key', () => {
    const [draft] = restoreObject(buildState({ lifecycle: 'archived' }));
    expect(draft?.payload.workspaceId).toBeUndefined();
  });

  it('softDeleteObject payload has no workspaceId key', () => {
    const [draft] = softDeleteObject(buildState({ lifecycle: 'active' }));
    expect(draft?.payload.workspaceId).toBeUndefined();
  });
});

// Lifecycle type re-exported through LuminaObject; referenced here only to
// keep the `Lifecycle` import used and documented for implementer.
const _lifecycleSample: Lifecycle = 'active';
void _lifecycleSample;
