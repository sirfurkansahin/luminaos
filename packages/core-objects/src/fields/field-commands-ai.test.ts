import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { defineField, updateField } from './field-commands.js';

import type { FieldDefinition } from './field-definition.js';
import type { FieldPermissions } from './field-permissions.js';
import type { FieldType } from './field-type-registry.js';
import type { ObjectType } from '../lumina-object.js';

/**
 * F1-T5 PR-B (RED step) — `ai`-specific `defineField`/`updateField`
 * behavior, a direct structural parallel to F1-T4's
 * `assertFormulaFieldRules` (`field-commands-formula.test.ts`), pinned here
 * for a NEW `assertAIFieldRules`. A NEW file, deliberately not appended to
 * the existing `field-commands.test.ts` / `field-commands-formula.test.ts`
 * (both left untouched, per task instructions).
 *
 * New ai-specific rules pinned here (per the approved F1-T5 plan):
 *   - An `ai` field can never carry a `defaultValue` (its value is always
 *     computed by the ai-gateway) -> ValidationError if one is supplied.
 *   - An `ai` field can never be directly edited -> ValidationError if
 *     `permissions` grants `'edit'` to ANY role.
 *   - `config.sourceFields`'s entries must each correspond to a known field
 *     (in `existingFieldDefinitions`, scoped to the same object type) ->
 *     ValidationError otherwise.
 *   - `config.sourceFields: []` (no sources at all -- a static,
 *     non-interpolated prompt) is legitimate -> succeeds.
 *   - UNLIKE `formula`, `ai` fields get NO cycle detection in this task (an
 *     `ai` field's `sourceFields` may reference another `ai` field with no
 *     graph-cycle check -- explicitly out of scope per the approved plan).
 *   - `updateField` re-applies all of the above when `config`/
 *     `defaultValue`/`permissions` are provided.
 *   - None of this applies to non-ai, non-formula field types; existing
 *     behavior only (already covered exhaustively by the untouched
 *     `field-commands.test.ts`) -- a single smoke test here only.
 *   - Regression guard: `formula`'s `defaultValue`/edit-permission rejection
 *     must keep working after whatever internal refactor (e.g. a shared
 *     helper for the "no defaultValue / no edit permission" pair) unifies
 *     `assertFormulaFieldRules` and `assertAIFieldRules` -- pinned here as a
 *     couple of representative cases only (full formula coverage remains in
 *     the untouched `field-commands-formula.test.ts`).
 *
 * Expected to fail (red) until `implementer`:
 *   - wires `ai` into `field-type-registry.ts` (`field-type-registry-ai.test.ts`
 *     pins that contract separately),
 *   - adds `packages/core-objects/src/fields/ai/ai-value.ts`,
 *   - adds `assertAIFieldRules` and wires it into `defineField`/`updateField`.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FIELD_DEFINITION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

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
    key: 'notes',
    label: 'Notes',
    fieldType: 'text',
    config: {},
    defaultValue: undefined,
    permissions: VIEW_ONLY_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildAIFieldState(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: FIELD_DEFINITION_ID,
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    key: 'summary',
    label: 'Summary',
    fieldType: 'ai',
    config: {
      promptTemplate: 'Summarize {notes}',
      sourceFields: ['notes'],
      outputType: 'text',
      refreshMode: 'manual',
    },
    defaultValue: undefined,
    permissions: VIEW_ONLY_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const notesField = buildStoredField({
  id: 'field-notes-id',
  key: 'notes',
  label: 'Notes',
  fieldType: 'text',
});

const baseAIInput = {
  fieldDefinitionId: FIELD_DEFINITION_ID,
  workspaceId: WORKSPACE_ID,
  objectType: 'task' as ObjectType,
  key: 'summary',
  label: 'Summary',
  fieldType: 'ai' as FieldType,
  config: {
    promptTemplate: 'Summarize {notes}',
    sourceFields: ['notes'],
    outputType: 'text' as const,
    refreshMode: 'manual' as const,
  },
  permissions: VIEW_ONLY_PERMISSIONS,
};

describe('defineField — ai-specific rules', () => {
  it('succeeds for a valid config referencing known source fields, with no defaultValue', () => {
    const drafts = defineField(baseAIInput, [notesField]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldDefined');
  });

  it('throws ValidationError when an explicit defaultValue is supplied', () => {
    expect(() =>
      defineField({ ...baseAIInput, defaultValue: 'pre-filled summary' }, [notesField]),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when any role has "edit" permission', () => {
    expect(() =>
      defineField({ ...baseAIInput, permissions: ONE_ROLE_CAN_EDIT_PERMISSIONS }, [notesField]),
    ).toThrow(ValidationError);
  });

  it('succeeds when every role is "view" or "hidden" (no edit anywhere)', () => {
    expect(() =>
      defineField({ ...baseAIInput, permissions: VIEW_ONLY_PERMISSIONS }, [notesField]),
    ).not.toThrow();
  });

  it('throws ValidationError when sourceFields references an unknown field key', () => {
    expect(() =>
      defineField(
        { ...baseAIInput, config: { ...baseAIInput.config, sourceFields: ['doesNotExist'] } },
        [notesField],
      ),
    ).toThrow(ValidationError);
  });

  it('succeeds when sourceFields references a field that exists among existingFieldDefinitions', () => {
    expect(() =>
      defineField({ ...baseAIInput, config: { ...baseAIInput.config, sourceFields: ['notes'] } }, [
        notesField,
      ]),
    ).not.toThrow();
  });

  it('succeeds with an empty sourceFields array (a static, non-interpolated prompt)', () => {
    expect(() =>
      defineField({ ...baseAIInput, config: { ...baseAIInput.config, sourceFields: [] } }, [
        notesField,
      ]),
    ).not.toThrow();
  });
});

describe('updateField — ai-specific rules', () => {
  it('succeeds when adding a new valid sourceFields entry that references an existing field', () => {
    const state = buildAIFieldState();
    const secondSourceField = buildStoredField({
      id: 'field-title-id',
      key: 'title',
      label: 'Title',
      fieldType: 'text',
    });

    const drafts = updateField(
      state,
      { config: { ...(state.config as object), sourceFields: ['notes', 'title'] } },
      [notesField, secondSourceField],
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldUpdated');
  });

  it('throws ValidationError when sourceFields is changed to reference an unknown field', () => {
    const state = buildAIFieldState();

    expect(() =>
      updateField(
        state,
        { config: { ...(state.config as object), sourceFields: ['doesNotExist'] } },
        [notesField],
      ),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when trying to add a defaultValue to an existing ai field', () => {
    const state = buildAIFieldState();

    expect(() => updateField(state, { defaultValue: 'pre-filled' })).toThrow(ValidationError);
  });

  it('throws ValidationError when trying to change permissions to include "edit" for any role', () => {
    const state = buildAIFieldState();

    expect(() => updateField(state, { permissions: ONE_ROLE_CAN_EDIT_PERMISSIONS })).toThrow(
      ValidationError,
    );
  });

  it('is unaffected on a non-ai, non-formula field (smoke test only -- exhaustive coverage lives in field-commands.test.ts)', () => {
    const textState = buildStoredField({ fieldType: 'text', config: {} });

    expect(() => updateField(textState, { label: 'New label' })).not.toThrow();
  });
});

describe('defineField — formula regression guard (post ai/formula shared-refactor)', () => {
  it('still throws ValidationError when a formula field is defined with an explicit defaultValue', () => {
    const numberFieldA = buildStoredField({
      id: 'field-a-id',
      key: 'a',
      label: 'A',
      fieldType: 'number',
    });

    expect(() =>
      defineField(
        {
          fieldDefinitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
          workspaceId: WORKSPACE_ID,
          objectType: 'task',
          key: 'total',
          label: 'Total',
          fieldType: 'formula',
          config: { expression: '{a}' },
          defaultValue: 42,
          permissions: VIEW_ONLY_PERMISSIONS,
        },
        [numberFieldA],
      ),
    ).toThrow(ValidationError);
  });
});
