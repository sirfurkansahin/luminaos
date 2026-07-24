import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { defineField, updateField } from './field-commands.js';

import type { FieldDefinition } from './field-definition.js';
import type { FieldPermissions } from './field-permissions.js';
import type { FieldType } from './field-type-registry.js';
import type { ObjectType } from '../lumina-object.js';

/**
 * F1-T4 PR-A2 (RED step) — formula-specific `defineField`/`updateField`
 * behavior. A NEW file, deliberately not appended to the existing
 * `field-commands.test.ts` (left untouched, per task instructions).
 *
 * Designed signature changes (backward-compatible — existing call sites in
 * `field-commands.test.ts` are unaffected since the new parameter is
 * optional and defaults to `[]`):
 *
 *   defineField(
 *     input: DefineFieldInput,
 *     existingFieldDefinitions: FieldDefinition[] = [],
 *   ): FieldEventDraft[]
 *
 *   updateField(
 *     state: FieldDefinition,
 *     input: UpdateFieldInput,
 *     existingFieldDefinitions: FieldDefinition[] = [],
 *   ): FieldEventDraft[]
 *
 * New formula-specific rules pinned here:
 *   - A formula field can never carry a `defaultValue` (its value is always
 *     computed) -> ValidationError if one is supplied.
 *   - A formula field can never be directly edited -> ValidationError if
 *     `permissions` grants `'edit'` to ANY role.
 *   - `config.expression`'s field references (`{fieldKey}`) must each
 *     correspond to a known field (in `existingFieldDefinitions`, scoped to
 *     the same object type) -> ValidationError ("references an unknown
 *     field") otherwise.
 *   - A formula-to-formula reference that would close a dependency cycle
 *     (via `formula-graph.ts`'s `findFormulaCycle`) -> ValidationError whose
 *     `.details` carries the cycle chain (mirrors F1-T3's `createRelation`
 *     cycle-`details` pattern).
 *   - A syntactically invalid expression -> ValidationError (parseFormula
 *     bubbling through).
 *   - `updateField` re-applies all of the above when `config`/
 *     `defaultValue`/`permissions` are provided, correctly excluding the
 *     field-being-updated's own stale `existingFieldDefinitions` entry from
 *     the cycle check.
 *   - None of this applies to non-formula field types; existing behavior
 *     only (already covered exhaustively by the untouched
 *     `field-commands.test.ts`).
 *
 * Expected to fail (red) until `implementer`:
 *   - wires `formula` into `field-type-registry.ts`,
 *   - adds `formula-graph.ts` / `field-aggregations.ts`,
 *   - extends `defineField`/`updateField` with the rules above.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FIELD_DEFINITION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

const VIEW_ONLY_PERMISSIONS: FieldPermissions = {
  owner: 'view',
  admin: 'hidden',
  member: 'view',
  guest: 'hidden',
};

const ONE_ROLE_CAN_EDIT_PERMISSIONS: FieldPermissions = {
  owner: 'edit',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

function buildStoredField(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'stored-field-id',
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    key: 'a',
    label: 'A',
    fieldType: 'number',
    config: {},
    defaultValue: undefined,
    permissions: VIEW_ONLY_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildFormulaFieldState(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: FIELD_DEFINITION_ID,
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    key: 'total',
    label: 'Total',
    fieldType: 'formula',
    config: { expression: '{a}' },
    defaultValue: undefined,
    permissions: VIEW_ONLY_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const numberFieldA = buildStoredField({
  id: 'field-a-id',
  key: 'a',
  label: 'A',
  fieldType: 'number',
});
const numberFieldB = buildStoredField({
  id: 'field-b-id',
  key: 'b',
  label: 'B',
  fieldType: 'number',
});

const baseFormulaInput = {
  fieldDefinitionId: FIELD_DEFINITION_ID,
  workspaceId: WORKSPACE_ID,
  objectType: 'task' as ObjectType,
  key: 'total',
  label: 'Total',
  fieldType: 'formula' as FieldType,
  config: { expression: '{a} + {b}' },
  permissions: VIEW_ONLY_PERMISSIONS,
};

describe('defineField — formula-specific rules', () => {
  it('succeeds for a valid expression referencing known fields, with no defaultValue', () => {
    const drafts = defineField(baseFormulaInput, [numberFieldA, numberFieldB]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldDefined');
  });

  it('throws ValidationError when an explicit defaultValue is supplied', () => {
    expect(() =>
      defineField({ ...baseFormulaInput, defaultValue: 42 }, [numberFieldA, numberFieldB]),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when any role has "edit" permission', () => {
    expect(() =>
      defineField({ ...baseFormulaInput, permissions: ONE_ROLE_CAN_EDIT_PERMISSIONS }, [
        numberFieldA,
        numberFieldB,
      ]),
    ).toThrow(ValidationError);
  });

  it('succeeds when every role is "view" or "hidden" (no edit anywhere)', () => {
    expect(() =>
      defineField({ ...baseFormulaInput, permissions: VIEW_ONLY_PERMISSIONS }, [
        numberFieldA,
        numberFieldB,
      ]),
    ).not.toThrow();
  });

  it('throws ValidationError when the expression references an unknown field key', () => {
    expect(() =>
      defineField({ ...baseFormulaInput, config: { expression: '{doesNotExist} + 1' } }, [
        numberFieldA,
        numberFieldB,
      ]),
    ).toThrow(ValidationError);
  });

  it('succeeds when the expression references a field that exists among existingFieldDefinitions', () => {
    expect(() =>
      defineField({ ...baseFormulaInput, config: { expression: '{a} * 2' } }, [numberFieldA]),
    ).not.toThrow();
  });

  it('throws ValidationError with a cycle chain in details when referencing a formula field that would close a cycle', () => {
    // Existing formula field B depends on A (candidate's own key).
    const existingFormulaFieldB = buildStoredField({
      id: 'field-B-id',
      key: 'B',
      label: 'B',
      fieldType: 'formula',
      config: { expression: '{A}' },
    });

    const input = { ...baseFormulaInput, key: 'A', config: { expression: '{B}' } };

    try {
      defineField(input, [existingFormulaFieldB]);
      expect.unreachable('expected defineField to throw ValidationError for a formula cycle');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toBeDefined();
    }
  });

  it('throws ValidationError for a syntactically invalid expression', () => {
    expect(() =>
      defineField({ ...baseFormulaInput, config: { expression: '{a} +' } }, [numberFieldA]),
    ).toThrow(ValidationError);
  });
});

describe('updateField — formula-specific rules', () => {
  it('throws ValidationError when the new expression would close a formula-to-formula cycle, excluding the stale self entry', () => {
    const state = buildFormulaFieldState({ key: 'A', config: { expression: '{a}' } });

    const existingFormulaFieldB = buildStoredField({
      id: 'field-B-id',
      key: 'B',
      label: 'B',
      fieldType: 'formula',
      config: { expression: '{A}' },
    });

    // `state` (A's own, stale, pre-update entry) is included in the array,
    // exactly as a real caller passing "every field definition for this
    // object type" would supply it -- it must not cause a false negative or
    // a false positive on its own; only B's real dependency on A matters.
    expect(() =>
      updateField(state, { config: { expression: '{B}' } }, [state, existingFormulaFieldB]),
    ).toThrow(ValidationError);
  });

  it('succeeds when the new expression is valid and non-cyclic', () => {
    const state = buildFormulaFieldState({ key: 'total2', config: { expression: '{a}' } });

    const drafts = updateField(state, { config: { expression: '{a} + 1' } }, [numberFieldA]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldUpdated');
  });

  it('is unaffected on a non-formula field (smoke test only -- exhaustive coverage lives in field-commands.test.ts)', () => {
    const textState = buildStoredField({ fieldType: 'text', config: {} });

    expect(() => updateField(textState, { label: 'New label' })).not.toThrow();
  });

  it('throws ValidationError when trying to add a defaultValue to an existing formula field', () => {
    const state = buildFormulaFieldState();

    expect(() => updateField(state, { defaultValue: 42 })).toThrow(ValidationError);
  });

  it('throws ValidationError when trying to change permissions to include "edit" for any role', () => {
    const state = buildFormulaFieldState();

    expect(() => updateField(state, { permissions: ONE_ROLE_CAN_EDIT_PERMISSIONS })).toThrow(
      ValidationError,
    );
  });
});
