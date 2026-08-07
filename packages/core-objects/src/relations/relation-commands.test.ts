import { describe, expect, it } from 'vitest';

import { ConflictError, InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { createRelation, removeRelation } from './relation-commands.js';

import type { Relation, RelationKind } from './relation.js';

/**
 * Designed command signatures (must be matched exactly by implementer):
 *
 *   export interface RelationEventDraft { type: string; payload: Record<string, unknown>; }
 *
 *   export interface CreateRelationInput {
 *     relationId: string; workspaceId: string; fromId: string; toId: string; kind: RelationKind;
 *   }
 *
 *   createRelation(input: CreateRelationInput, existingRelations: Relation[]): RelationEventDraft[]
 *     -> single draft, type 'RelationCreated', payload
 *        { relationId, workspaceId, fromId, toId, kind } (every input field).
 *     -> throws ValidationError when input.fromId === input.toId, for every kind
 *        (self-relations are invalid regardless of kind).
 *     -> throws ValidationError for an unknown/invalid kind string.
 *     -> parentChild: throws ConflictError when `existingRelations` already
 *        contains an ACTIVE parentChild relation whose toId equals the new
 *        toId (the child already has a parent) — a 'removed' relation for the
 *        same toId must NOT block. Throws ValidationError (details: a cycle
 *        chain array containing the involved ids) when the proposed edge
 *        would create a parentChild cycle among ACTIVE parentChild relations
 *        (self-parent included).
 *     -> dependency: throws ValidationError (details: cycle chain array) when
 *        the proposed edge would create a dependency cycle among ACTIVE
 *        dependency relations. A 'removed' dependency relation must NOT
 *        participate in cycle detection.
 *     -> reference: no cycle checks. Throws ConflictError for a duplicate
 *        UNORDERED pair (existing ACTIVE {fromId:A,toId:B,kind:'reference'}
 *        blocks both a new A->B and a new B->A reference). A 'removed'
 *        reference for the same pair must NOT block. The same pair under a
 *        DIFFERENT kind is not a duplicate.
 *
 *   removeRelation(state: Relation): RelationEventDraft[]
 *     -> on state.status === 'active': single draft, type 'RelationRemoved',
 *        payload { relationId: state.id }.
 *     -> throws InvalidObjectStateError when state.status === 'removed'.
 *
 * RelationEventDraft = { type: string; payload: Record<string, unknown> }
 * (same shape as F1-T1's ObjectEventDraft / F1-T2's FieldEventDraft).
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RELATION_ID = 'relation-under-test';

let relationCounter = 0;

function buildRelation(overrides: Partial<Relation> = {}): Relation {
  relationCounter += 1;
  return {
    id: `existing-relation-${String(relationCounter)}`,
    workspaceId: WORKSPACE_ID,
    fromId: 'obj-from',
    toId: 'obj-to',
    kind: 'reference',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function getThrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('createRelation', () => {
  it('returns a single RelationCreated draft carrying every field from the input', () => {
    const drafts = createRelation(
      {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-a',
        toId: 'obj-b',
        kind: 'reference',
      },
      [],
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('RelationCreated');
    expect(drafts[0]?.payload).toEqual({
      relationId: RELATION_ID,
      workspaceId: WORKSPACE_ID,
      fromId: 'obj-a',
      toId: 'obj-b',
      kind: 'reference',
    });
  });

  it('throws ValidationError when fromId === toId, regardless of kind', () => {
    const kinds: RelationKind[] = ['parentChild', 'reference', 'dependency'];

    for (const kind of kinds) {
      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-a',
            toId: 'obj-a',
            kind,
          },
          [],
        ),
      ).toThrow(ValidationError);
    }
  });

  it('throws ValidationError for an unknown/invalid kind string', () => {
    expect(() =>
      createRelation(
        {
          relationId: RELATION_ID,
          workspaceId: WORKSPACE_ID,
          fromId: 'obj-a',
          toId: 'obj-b',
          kind: 'bogus-kind' as RelationKind,
        },
        [],
      ),
    ).toThrow(ValidationError);
  });

  describe('parentChild', () => {
    it('throws ConflictError when the child already has an active parent', () => {
      const existing = [
        buildRelation({
          fromId: 'obj-parent-1',
          toId: 'obj-child',
          kind: 'parentChild',
          status: 'active',
        }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-parent-2',
            toId: 'obj-child',
            kind: 'parentChild',
          },
          existing,
        ),
      ).toThrow(ConflictError);
    });

    it('does not block a new parent assignment when the existing parent relation for that child is removed', () => {
      const existing = [
        buildRelation({
          fromId: 'obj-parent-1',
          toId: 'obj-child',
          kind: 'parentChild',
          status: 'removed',
        }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-parent-2',
            toId: 'obj-child',
            kind: 'parentChild',
          },
          existing,
        ),
      ).not.toThrow();
    });

    it('throws ValidationError for a self-parent (X parent of X)', () => {
      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-x',
            toId: 'obj-x',
            kind: 'parentChild',
          },
          [],
        ),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError with a cycle chain in details when assigning a grandchild as parent ("torununa ebeveynlik")', () => {
      // X is parent of A, A is parent of Y (X -> A -> Y).
      const existing = [
        buildRelation({ fromId: 'obj-x', toId: 'obj-a', kind: 'parentChild', status: 'active' }),
        buildRelation({ fromId: 'obj-a', toId: 'obj-y', kind: 'parentChild', status: 'active' }),
      ];

      const thrown = getThrown(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-y',
            toId: 'obj-x',
            kind: 'parentChild',
          },
          existing,
        ),
      );

      expect(thrown).toBeInstanceOf(ValidationError);
      const validationError = thrown as ValidationError;
      expect(validationError.details).toBeDefined();
      const detailsText = JSON.stringify(validationError.details);
      expect(detailsText).toContain('obj-x');
      expect(detailsText).toContain('obj-a');
      expect(detailsText).toContain('obj-y');
    });

    it('succeeds for a non-cyclic parentChild assignment among unrelated ids', () => {
      const existing = [
        buildRelation({ fromId: 'obj-x', toId: 'obj-a', kind: 'parentChild', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-unrelated-parent',
            toId: 'obj-unrelated-child',
            kind: 'parentChild',
          },
          existing,
        ),
      ).not.toThrow();
    });
  });

  describe('dependency', () => {
    it('throws ValidationError with a cycle chain in details for a 3-node cycle closure (A blocks B, B blocks C, then C blocks A)', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'dependency', status: 'active' }),
        buildRelation({ fromId: 'obj-b', toId: 'obj-c', kind: 'dependency', status: 'active' }),
      ];

      const thrown = getThrown(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-c',
            toId: 'obj-a',
            kind: 'dependency',
          },
          existing,
        ),
      );

      expect(thrown).toBeInstanceOf(ValidationError);
      const detailsText = JSON.stringify((thrown as ValidationError).details);
      expect(detailsText).toContain('obj-a');
      expect(detailsText).toContain('obj-b');
      expect(detailsText).toContain('obj-c');
    });

    it('throws ValidationError for a direct 2-node cycle (A blocks B, then attempt B blocks A)', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'dependency', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-b',
            toId: 'obj-a',
            kind: 'dependency',
          },
          existing,
        ),
      ).toThrow(ValidationError);
    });

    it('succeeds for non-cyclic dependency edges', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'dependency', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-c',
            toId: 'obj-d',
            kind: 'dependency',
          },
          existing,
        ),
      ).not.toThrow();
    });

    it('ignores removed dependency relations when detecting cycles', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'dependency', status: 'removed' }),
        buildRelation({ fromId: 'obj-b', toId: 'obj-c', kind: 'dependency', status: 'active' }),
      ];

      // If the removed obj-a -> obj-b edge were still considered active,
      // proposing obj-c -> obj-a would close a cycle. It must not.
      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-c',
            toId: 'obj-a',
            kind: 'dependency',
          },
          existing,
        ),
      ).not.toThrow();
    });
  });

  describe('reference', () => {
    it('has no cycle checks — a long reference chain that would close a loop is allowed', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'reference', status: 'active' }),
        buildRelation({ fromId: 'obj-b', toId: 'obj-c', kind: 'reference', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-c',
            toId: 'obj-a',
            kind: 'reference',
          },
          existing,
        ),
      ).not.toThrow();
    });

    it('throws ConflictError for a duplicate reference in the same order (existing A->B, attempt A->B)', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'reference', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-a',
            toId: 'obj-b',
            kind: 'reference',
          },
          existing,
        ),
      ).toThrow(ConflictError);
    });

    it('throws ConflictError for a duplicate reference in reversed order (existing A->B, attempt B->A)', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'reference', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-b',
            toId: 'obj-a',
            kind: 'reference',
          },
          existing,
        ),
      ).toThrow(ConflictError);
    });

    it('does not block a new reference when the existing reference for the same pair is removed', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'reference', status: 'removed' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-a',
            toId: 'obj-b',
            kind: 'reference',
          },
          existing,
        ),
      ).not.toThrow();
    });

    it('does not treat the same pair under a different kind as a duplicate', () => {
      const existing = [
        buildRelation({ fromId: 'obj-a', toId: 'obj-b', kind: 'reference', status: 'active' }),
      ];

      expect(() =>
        createRelation(
          {
            relationId: RELATION_ID,
            workspaceId: WORKSPACE_ID,
            fromId: 'obj-a',
            toId: 'obj-b',
            kind: 'dependency',
          },
          existing,
        ),
      ).not.toThrow();
    });
  });
});

/**
 * F1-T12 PR3 (RED step) — ADR-0012 §e "zaman bloklarının görevi
 * bloklaması": a `timeblock` LuminaObject "blocks time for" a task via a
 * NEW `RelationKind`, `'blocks-time-for'` (`fromId` = the timeblock's
 * object id, `toId` = the task it blocks time for).
 *
 * Designed contract (must be matched exactly by implementer):
 *
 *   - `./relation.ts`'s `RelationKind` union gains `'blocks-time-for'`.
 *   - `KNOWN_RELATION_KINDS` (this module) gains `'blocks-time-for'`.
 *   - `createRelation` needs NO special-case validation block for this kind
 *     (unlike `parentChild`'s uniqueness+cycle check, `dependency`'s cycle
 *     check, or `reference`'s duplicate check) — a single task may have
 *     MULTIPLE `blocks-time-for` relations pointing at it (one per
 *     timeblock instance blocking time for it), so no uniqueness/duplicate
 *     constraint applies. It only needs to pass `isKnownRelationKind` so
 *     `createRelation` does not throw "unknown relation kind" for it.
 *
 * EXPECTED RED STATE today: `'blocks-time-for'` is not yet a member of
 * `RelationKind`, so every literal `kind: 'blocks-time-for'` below fails
 * TypeScript compilation ("Type '"blocks-time-for"' is not assignable to
 * type 'RelationKind'"). Once `RelationKind` gains the member but
 * `KNOWN_RELATION_KINDS` does not yet list it, these tests would instead
 * fail at runtime with a thrown `ValidationError` ("unknown relation
 * kind") on the `.not.toThrow()` assertions below.
 */
describe('createRelation — blocks-time-for (F1-T12 PR3)', () => {
  it('succeeds with no special-case validation and produces a RelationCreated draft with kind "blocks-time-for"', () => {
    const drafts = createRelation(
      {
        relationId: RELATION_ID,
        workspaceId: WORKSPACE_ID,
        fromId: 'obj-timeblock-1',
        toId: 'obj-task',
        kind: 'blocks-time-for',
      },
      [],
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('RelationCreated');
    expect(drafts[0]?.payload).toEqual({
      relationId: RELATION_ID,
      workspaceId: WORKSPACE_ID,
      fromId: 'obj-timeblock-1',
      toId: 'obj-task',
      kind: 'blocks-time-for',
    });
  });

  it('allows MULTIPLE blocks-time-for relations against the SAME toId (task) from different timeblocks — no uniqueness constraint', () => {
    const existing = [
      buildRelation({
        fromId: 'obj-timeblock-1',
        toId: 'obj-task',
        kind: 'blocks-time-for',
        status: 'active',
      }),
    ];

    expect(() =>
      createRelation(
        {
          relationId: RELATION_ID,
          workspaceId: WORKSPACE_ID,
          fromId: 'obj-timeblock-2',
          toId: 'obj-task',
          kind: 'blocks-time-for',
        },
        existing,
      ),
    ).not.toThrow();
  });
});

describe('removeRelation', () => {
  it('returns a single RelationRemoved draft with the expected payload when state is active', () => {
    const state = buildRelation({ status: 'active' });
    const drafts = removeRelation(state);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('RelationRemoved');
    expect(drafts[0]?.payload).toEqual({ relationId: state.id });
  });

  it('throws InvalidObjectStateError when the relation is already removed', () => {
    const state = buildRelation({ status: 'removed' });

    expect(() => removeRelation(state)).toThrow(InvalidObjectStateError);
  });
});
