import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { clearRecurrenceRule, setRecurrenceRule } from './recurrence-rule-commands.js';

import type { LuminaObject } from './lumina-object.js';

/**
 * F1-T10 PR4 (RED step) — `recurrenceRule` command layer, per spec item 4
 * (`docs/specs/F1-E3/F1-T10-gorev-deneyimi.md`): "Task'a `recurrenceRule`
 * alanı (`{ frequency: 'daily'|'weekly'|'monthly', interval: number,
 * byWeekday?: number[], endDate?: string }`)."
 *
 * `./recurrence-rule-commands.ts` does NOT exist yet — the import above is
 * expected to fail module resolution ("Cannot find module") the instant this
 * file loads, before any `describe`/`it` block runs. That is the correct red
 * state; `implementer` must create `./recurrence-rule-commands.ts` (plus the
 * `RecurrenceRule` type + `recurrenceRule?` field on `LuminaObject` in
 * `./lumina-object.ts`, and the `RecurrenceRuleSet`/`RecurrenceRuleCleared`
 * folding in `./replay.ts` — see `./replay.test.ts`'s own new "recurrence
 * rule events" `describe` block for that half of the contract) to turn this
 * green.
 *
 * ============================================================================
 * WHERE `recurrenceRule` LIVES — DESIGN DECISION (test-writer's own call,
 * made explicit here per this PR's instructions, since neither the spec nor
 * ADR-0010 pins this explicitly):
 *
 * Spec item 1 says the `status`/`priority` fields are provisioned "F1-T2
 * mekanizmasıyla" (via the Custom Fields mechanism) — an explicit pointer to
 * F1-T2. Spec item 4 (`recurrenceRule`) carries NO such pointer; it only
 * states the shape. Spec item 3 (`checklist`) is the closer precedent: "Ayrı
 * LuminaObject açılmaz — `packages/core-objects`'e gömülü `ChecklistItem[]`
 * değer tipi eklenir" — i.e., checklist deliberately did NOT go through
 * Custom Fields, because F1-T2's `FieldType` registry
 * (`./fields/field-type-registry.ts`) has no field type that can represent a
 * compound/structured value: every existing type is a scalar, an enum
 * (`select`/`multiSelect`, single string values matched against a flat
 * `options` list), or a flat array of scalars (`people`). `recurrenceRule`'s
 * shape — a single object with a required enum member, a required number,
 * and two OPTIONAL members (one of which, `byWeekday`, is itself an array) —
 * has the exact same structural mismatch that justified `checklist`'s
 * embedded-value-type exception: it cannot be expressed as a `select` (not
 * an enum of atomic values), a `number`/`text` (loses structure/type
 * safety), or any other existing `FieldType` without lying about its shape
 * (e.g. JSON-stringifying it into a `text` field, which would silently defeat
 * `validateFieldValue`'s per-type schema checking — the exact protection
 * Custom Fields exists to provide). Extending `FieldType` itself with a new
 * generic "object"/"json" member is a bigger, cross-cutting Custom Fields
 * schema change with its own config/value-validation design space, is not
 * requested by this spec item, and is explicitly out of this PR's scope
 * (CLAUDE.md: "Spec'te olmayan kapsamı ... ekleme").
 *
 * Conclusion: `recurrenceRule` follows `checklist`'s precedent — an embedded,
 * OPTIONAL `LuminaObject` field (`recurrenceRule?: RecurrenceRule`, present
 * on every object type structurally, exactly like `checklist: ChecklistItem[]`
 * is, even though it is only ever meaningfully populated on `task` objects —
 * no object-type-conditional branching exists anywhere else in this layer
 * either), with its own dedicated command surface
 * (`setRecurrenceRule`/`clearRecurrenceRule`, mirroring
 * `./checklist-commands.ts`'s `addChecklistItem`/`removeChecklistItem` shape)
 * and its own replay folding (`RecurrenceRuleSet`/`RecurrenceRuleCleared`,
 * mirroring `ChecklistItemAdded`/`ChecklistItemRemoved`). This keeps
 * `packages/core-objects` framework-free, keeps the value's own shape
 * strongly typed end-to-end (no `unknown`/JSON-stringify escape hatch), and
 * does not touch F1-T2's `FieldType` registry at all — it is a completely
 * separate, narrower extension than a new Custom Field type would be.
 *
 * `clearRecurrenceRule` is not itself required by any spec bullet — it is
 * this PR's own minimal completion of the value's command surface (a "turn
 * off recurrence" affordance), mirroring `checklist`'s own
 * add/toggle/remove/reorder symmetry. Flagged here explicitly as a design
 * choice, not a pinned acceptance criterion.
 *
 * ============================================================================
 * DESIGNED COMMAND SIGNATURES (implementer must match exactly):
 *
 *   setRecurrenceRule(state: LuminaObject, input: RecurrenceRule): ObjectEventDraft[]
 *     -> single draft, type 'RecurrenceRuleSet',
 *        payload { objectId, frequency, interval, byWeekday?, endDate? }
 *        (byWeekday/endDate OMITTED from the payload entirely when not
 *        provided in `input` — not present as `undefined` keys).
 *     -> throws ValidationError with { objectId, frequency } context if
 *        `frequency` is not one of 'daily' | 'weekly' | 'monthly'.
 *     -> throws ValidationError with { objectId, interval } context if
 *        `interval` is not an integer >= 1.
 *     -> throws ValidationError with { objectId } context if `byWeekday` is
 *        provided and is not an array of integers each in the inclusive
 *        range [0, 6] (0 = Sunday, ISO-adjacent weekday-index convention).
 *     -> throws ValidationError with { objectId } context if `endDate` is
 *        provided and is not a `YYYY-MM-DD`-shaped string (same shape as
 *        `./fields/field-type-registry.ts`'s `date` field type, `z.iso.date()`).
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'
 *        (mirrors every checklist command's deleted-object guard; archived
 *        objects ARE allowed, same rule as renameObject/checklist commands).
 *
 *   clearRecurrenceRule(state: LuminaObject): ObjectEventDraft[]
 *     -> single draft, type 'RecurrenceRuleCleared', payload { objectId }.
 *     -> throws ValidationError with { objectId } context if
 *        `state.recurrenceRule` is undefined (nothing to clear).
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'.
 * ============================================================================
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: number[];
  endDate?: string;
}

function buildState(overrides: Record<string, unknown> = {}): LuminaObject {
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
  } as unknown as LuminaObject;
}

describe('setRecurrenceRule', () => {
  it('returns a single RecurrenceRuleSet draft with only the required fields when byWeekday/endDate are omitted', () => {
    const drafts = setRecurrenceRule(buildState(), { frequency: 'daily', interval: 1 });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('RecurrenceRuleSet');
    expect(drafts[0]?.payload).toEqual({
      objectId: OBJECT_ID,
      frequency: 'daily',
      interval: 1,
    });
  });

  it('includes byWeekday/endDate in the payload when provided', () => {
    const drafts = setRecurrenceRule(buildState(), {
      frequency: 'weekly',
      interval: 2,
      byWeekday: [1, 3, 5],
      endDate: '2026-12-31',
    });

    expect(drafts[0]?.payload).toEqual({
      objectId: OBJECT_ID,
      frequency: 'weekly',
      interval: 2,
      byWeekday: [1, 3, 5],
      endDate: '2026-12-31',
    });
  });

  it('throws ValidationError with { objectId, frequency } context for an unknown frequency', () => {
    expect(() =>
      setRecurrenceRule(buildState(), {
        frequency: 'yearly' as unknown as RecurrenceRule['frequency'],
        interval: 1,
      }),
    ).toThrow(ValidationError);

    try {
      setRecurrenceRule(buildState(), {
        frequency: 'yearly' as unknown as RecurrenceRule['frequency'],
        interval: 1,
      });
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID, frequency: 'yearly' });
    }
  });

  it('throws ValidationError with { objectId, interval } context when interval is zero', () => {
    expect(() => setRecurrenceRule(buildState(), { frequency: 'daily', interval: 0 })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError with { objectId, interval } context when interval is negative', () => {
    expect(() => setRecurrenceRule(buildState(), { frequency: 'daily', interval: -1 })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError with { objectId, interval } context when interval is not an integer', () => {
    expect(() => setRecurrenceRule(buildState(), { frequency: 'daily', interval: 1.5 })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when byWeekday contains a value outside [0, 6]', () => {
    expect(() =>
      setRecurrenceRule(buildState(), { frequency: 'weekly', interval: 1, byWeekday: [0, 7] }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when byWeekday contains a non-integer', () => {
    expect(() =>
      setRecurrenceRule(buildState(), {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [1, 2.5],
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when endDate is not YYYY-MM-DD shaped', () => {
    expect(() =>
      setRecurrenceRule(buildState(), {
        frequency: 'monthly',
        interval: 1,
        endDate: 'not-a-date',
      }),
    ).toThrow(ValidationError);
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    expect(() =>
      setRecurrenceRule(buildState({ lifecycle: 'deleted' }), { frequency: 'daily', interval: 1 }),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object (same rule as checklist commands / renameObject)', () => {
    expect(() =>
      setRecurrenceRule(buildState({ lifecycle: 'archived' }), { frequency: 'daily', interval: 1 }),
    ).not.toThrow();
  });
});

describe('clearRecurrenceRule', () => {
  it('returns a single RecurrenceRuleCleared draft with the expected payload', () => {
    const drafts = clearRecurrenceRule(
      buildState({ recurrenceRule: { frequency: 'daily', interval: 1 } }),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('RecurrenceRuleCleared');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID });
  });

  it('throws ValidationError with { objectId } context when there is no recurrenceRule to clear', () => {
    expect(() => clearRecurrenceRule(buildState({ recurrenceRule: undefined }))).toThrow(
      ValidationError,
    );

    try {
      clearRecurrenceRule(buildState({ recurrenceRule: undefined }));
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID });
    }
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    expect(() =>
      clearRecurrenceRule(
        buildState({ recurrenceRule: { frequency: 'daily', interval: 1 }, lifecycle: 'deleted' }),
      ),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object', () => {
    expect(() =>
      clearRecurrenceRule(
        buildState({ recurrenceRule: { frequency: 'daily', interval: 1 }, lifecycle: 'archived' }),
      ),
    ).not.toThrow();
  });
});
