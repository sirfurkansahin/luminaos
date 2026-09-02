import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { createTrigger, deleteTrigger, updateTrigger } from './trigger-commands.js';

import type { ConditionSpec, ScheduleSpec, Trigger, TriggerSpec } from './trigger.js';

/**
 * F2-T15 PR1 (RED step) — designed command signatures (must be matched
 * exactly by `implementer`), mirroring `saved-view-commands.ts`'s pure-
 * command-fn discipline (`TriggerEventDraft[]` return shape, same
 * `{ type, payload }` draft shape as `SavedViewEventDraft`) per ADR-0032
 * Karar (i)/(l):
 *
 *   export interface CreateTriggerInput {
 *     triggerId: string; workspaceId: string; name: string; spec: TriggerSpec;
 *   }
 *
 *   createTrigger(input: CreateTriggerInput): TriggerEventDraft[]
 *     -> single draft, type 'TriggerCreated', payload carrying
 *        { triggerId, workspaceId, name, kind: input.spec.kind, spec: input.spec }.
 *     -> throws ValidationError when `name.trim().length === 0` (empty or
 *        whitespace-only name) — mirrors `createSavedView`'s guard.
 *     -> throws ValidationError when `spec.kind === 'scheduled'` and
 *        `intervalMinutes` is not a positive integer (0, negative, or
 *        non-integer all rejected).
 *     -> throws ValidationError when `spec.kind === 'condition'` and
 *        `objectType`/`fieldKey` are empty.
 *     -> throws ValidationError when `spec.kind === 'condition'` and
 *        `pattern`/`flags` fail `assertSafeRegexPattern` (ADR-0032 Karar e) —
 *        an unsafe pattern must never silently create the trigger.
 *
 *   export interface UpdateTriggerInput { name?: string; spec?: TriggerSpec; }
 *
 *   updateTrigger(state: Trigger, input: UpdateTriggerInput): TriggerEventDraft[]
 *     -> single draft, type 'TriggerUpdated', payload = { triggerId: state.id }
 *        plus ONLY the keys actually present (!== undefined) on `input` —
 *        mirrors `updateSavedView`'s "undefined key = unchanged" convention.
 *     -> throws InvalidObjectStateError when `state.lifecycle === 'deleted'`.
 *     -> re-validates a provided `spec` the same way `createTrigger` does
 *        (intervalMinutes / objectType+fieldKey / regex-safety), so an update
 *        can never bypass the create-path's safety checks.
 *     -> throws ValidationError when `input.spec.kind` does not match
 *        `state.kind` (a trigger's kind is immutable once created).
 *
 *   deleteTrigger(state: Trigger): TriggerEventDraft[]
 *     -> single draft, type 'TriggerDeleted', payload { triggerId: state.id }.
 *     -> throws InvalidObjectStateError when `state.lifecycle === 'deleted'`.
 *
 * ASSUMPTION (flagged per task instructions): the ADR-0032 schema sketch's
 * `automation_triggers` table has NO `name` column — but a workspace admin
 * needs to identify triggers in a list UI, so this test file assumes the
 * DOMAIN `Trigger`/`CreateTriggerInput` shape carries a `name: string` field
 * (validated the same way `createSavedView` validates its own `name`), even
 * though how/whether that name is projected into the DB read-model is left
 * to `implementer`/a future PR to reconcile. This is the one genuinely
 * ambiguous judgment call in this PR's contract.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TRIGGER_ID = 'trigger-under-test';

const SCHEDULE_SPEC: ScheduleSpec = {
  kind: 'scheduled',
  intervalMinutes: 60,
  actionTemplate: { title: 'Weekly review' },
};

const CONDITION_SPEC: ConditionSpec = {
  kind: 'condition',
  objectType: 'task',
  fieldKey: 'title',
  pattern: '^INV-\\d{4}$',
  flags: '',
  actionTemplate: { title: 'Follow up on invoice' },
};

function buildCreateInput(
  overrides: Partial<{
    triggerId: string;
    workspaceId: string;
    name: string;
    spec: TriggerSpec;
  }> = {},
) {
  return {
    triggerId: TRIGGER_ID,
    workspaceId: WORKSPACE_ID,
    name: 'My trigger',
    spec: SCHEDULE_SPEC,
    ...overrides,
  };
}

let triggerCounter = 0;

function buildTrigger(overrides: Partial<Trigger> = {}): Trigger {
  triggerCounter += 1;
  return {
    id: `existing-trigger-${String(triggerCounter)}`,
    workspaceId: WORKSPACE_ID,
    name: 'Existing trigger',
    kind: 'scheduled',
    spec: SCHEDULE_SPEC,
    lastFiredAt: null,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createTrigger', () => {
  it('returns a single TriggerCreated draft carrying triggerId/workspaceId/name/kind/spec', () => {
    const input = buildCreateInput();
    const drafts = createTrigger(input);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('TriggerCreated');
    expect(drafts[0]?.payload).toEqual({
      triggerId: input.triggerId,
      workspaceId: input.workspaceId,
      name: input.name,
      kind: input.spec.kind,
      spec: input.spec,
    });
  });

  it('accepts a valid kind:"scheduled" spec (positive integer intervalMinutes)', () => {
    expect(() =>
      createTrigger(buildCreateInput({ spec: { ...SCHEDULE_SPEC, intervalMinutes: 30 } })),
    ).not.toThrow();
  });

  it.each([0, -5, -1])(
    'throws ValidationError when scheduled intervalMinutes is not positive (%s)',
    (intervalMinutes) => {
      expect(() =>
        createTrigger(buildCreateInput({ spec: { ...SCHEDULE_SPEC, intervalMinutes } })),
      ).toThrow(ValidationError);
    },
  );

  it('throws ValidationError when scheduled intervalMinutes is not an integer (1.5)', () => {
    expect(() =>
      createTrigger(buildCreateInput({ spec: { ...SCHEDULE_SPEC, intervalMinutes: 1.5 } })),
    ).toThrow(ValidationError);
  });

  it('produces a TriggerCreated draft for a valid kind:"condition" spec', () => {
    const input = buildCreateInput({ spec: CONDITION_SPEC });
    const drafts = createTrigger(input);

    expect(drafts[0]?.type).toBe('TriggerCreated');
    expect(drafts[0]?.payload.spec).toEqual(CONDITION_SPEC);
    expect(drafts[0]?.payload.kind).toBe('condition');
  });

  it.each(['', '   '])('throws ValidationError when condition objectType is "%s"', (objectType) => {
    expect(() =>
      createTrigger(buildCreateInput({ spec: { ...CONDITION_SPEC, objectType } })),
    ).toThrow(ValidationError);
  });

  it.each(['', '   '])('throws ValidationError when condition fieldKey is "%s"', (fieldKey) => {
    expect(() =>
      createTrigger(buildCreateInput({ spec: { ...CONDITION_SPEC, fieldKey } })),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when the condition pattern is an unsafe (catastrophic-backtracking) regex', () => {
    expect(() =>
      createTrigger(buildCreateInput({ spec: { ...CONDITION_SPEC, pattern: '(a+)+' } })),
    ).toThrow(ValidationError);
  });

  it('does not create a trigger at all when the condition pattern is unsafe (no draft escapes)', () => {
    let drafts;
    try {
      drafts = createTrigger(buildCreateInput({ spec: { ...CONDITION_SPEC, pattern: '(a+)+' } }));
    } catch {
      drafts = undefined;
    }
    expect(drafts).toBeUndefined();
  });

  it('throws ValidationError for an unknown spec.kind', () => {
    expect(() =>
      createTrigger(buildCreateInput({ spec: { kind: 'bogus' } as unknown as TriggerSpec })),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when name is empty', () => {
    expect(() => createTrigger(buildCreateInput({ name: '' }))).toThrow(ValidationError);
  });

  it('throws ValidationError when name is whitespace-only', () => {
    expect(() => createTrigger(buildCreateInput({ name: '   ' }))).toThrow(ValidationError);
  });
});

describe('updateTrigger', () => {
  it('includes only the provided keys in the payload (undefined-means-unchanged convention)', () => {
    const state = buildTrigger();
    const drafts = updateTrigger(state, { name: 'Renamed' });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('TriggerUpdated');
    expect(drafts[0]?.payload).toEqual({ triggerId: state.id, name: 'Renamed' });
    expect(Object.keys(drafts[0]?.payload ?? {})).toEqual(['triggerId', 'name']);
  });

  it('an empty update input produces a payload with only triggerId', () => {
    const state = buildTrigger();
    const drafts = updateTrigger(state, {});

    expect(drafts[0]?.payload).toEqual({ triggerId: state.id });
  });

  it('throws InvalidObjectStateError when the trigger is already deleted', () => {
    const state = buildTrigger({ lifecycle: 'deleted' });

    expect(() => updateTrigger(state, { name: 'Should not apply' })).toThrow(
      InvalidObjectStateError,
    );
  });

  it('throws ValidationError when the update name is empty', () => {
    const state = buildTrigger();

    expect(() => updateTrigger(state, { name: '' })).toThrow(ValidationError);
  });

  it('throws ValidationError when input.spec.kind does not match state.kind', () => {
    const state = buildTrigger({ kind: 'scheduled', spec: SCHEDULE_SPEC });

    expect(() => updateTrigger(state, { spec: CONDITION_SPEC })).toThrow(ValidationError);
  });

  it('re-validates a scheduled update spec: rejects a non-positive intervalMinutes', () => {
    const state = buildTrigger({ kind: 'scheduled', spec: SCHEDULE_SPEC });

    expect(() => updateTrigger(state, { spec: { ...SCHEDULE_SPEC, intervalMinutes: 0 } })).toThrow(
      ValidationError,
    );
  });

  it("re-validates a condition update's pattern through assertSafeRegexPattern (cannot bypass create-path safety)", () => {
    const state = buildTrigger({ kind: 'condition', spec: CONDITION_SPEC });

    expect(() => updateTrigger(state, { spec: { ...CONDITION_SPEC, pattern: '(a*)*' } })).toThrow(
      ValidationError,
    );
  });

  it('accepts a valid condition update changing the pattern to a safe one', () => {
    const state = buildTrigger({ kind: 'condition', spec: CONDITION_SPEC });

    expect(() =>
      updateTrigger(state, { spec: { ...CONDITION_SPEC, pattern: 'urgent' } }),
    ).not.toThrow();
  });
});

describe('deleteTrigger', () => {
  it('returns a single TriggerDeleted draft with the expected payload when active', () => {
    const state = buildTrigger({ lifecycle: 'active' });
    const drafts = deleteTrigger(state);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('TriggerDeleted');
    expect(drafts[0]?.payload).toEqual({ triggerId: state.id });
  });

  it('throws InvalidObjectStateError when the trigger is already deleted', () => {
    const state = buildTrigger({ lifecycle: 'deleted' });

    expect(() => deleteTrigger(state)).toThrow(InvalidObjectStateError);
  });
});
