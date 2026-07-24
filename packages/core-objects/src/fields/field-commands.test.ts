import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { archiveField, defineField, updateField } from './field-commands.js';

import type { FieldDefinition } from './field-definition.js';
import type { FieldPermissions } from './field-permissions.js';
import type { FieldType } from './field-type-registry.js';
import type { ObjectType } from '../lumina-object.js';

/**
 * Designed command signatures (must be matched exactly by implementer):
 *
 *   defineField(input: {
 *     fieldDefinitionId: string; workspaceId: string; objectType: ObjectType;
 *     key: string; label: string; fieldType: FieldType; config: unknown;
 *     defaultValue?: unknown; permissions: FieldPermissions;
 *   }): FieldEventDraft[]
 *     -> single draft, type 'FieldDefined', payload carrying every input field.
 *     -> throws ValidationError for: unknown objectType (isKnownObjectType),
 *        unknown fieldType, invalid config (validateFieldConfig), invalid
 *        defaultValue if provided (validateFieldValue), and permissions not
 *        covering exactly the 4 roles with valid FieldPermissionLevel values.
 *
 *   updateField(state: FieldDefinition, input: {
 *     label?: string; config?: unknown; defaultValue?: unknown;
 *     permissions?: FieldPermissions;
 *   }): FieldEventDraft[]
 *     -> single draft, type 'FieldUpdated', payload carrying only the
 *        provided fields (+ fieldDefinitionId).
 *     -> throws InvalidObjectStateError if state.lifecycle === 'archived'.
 *     -> re-validates any provided config/defaultValue against the registry
 *        (same violations as defineField).
 *
 *   archiveField(state: FieldDefinition): FieldEventDraft[]
 *     -> single draft, type 'FieldArchived', payload { fieldDefinitionId: state.id }.
 *     -> throws InvalidObjectStateError if state.lifecycle === 'archived' already.
 *
 * FieldEventDraft = { type: string; payload: Record<string, unknown> }
 * (same shape as F1-T1's ObjectEventDraft).
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FIELD_DEFINITION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

const VALID_PERMISSIONS: FieldPermissions = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'view',
};

function buildFieldDefinitionState(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: FIELD_DEFINITION_ID,
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    key: 'status',
    label: 'Status',
    fieldType: 'select',
    config: { options: ['todo', 'done'] },
    defaultValue: undefined,
    permissions: VALID_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('defineField', () => {
  const validInput = {
    fieldDefinitionId: FIELD_DEFINITION_ID,
    workspaceId: WORKSPACE_ID,
    objectType: 'task' as ObjectType,
    key: 'status',
    label: 'Status',
    fieldType: 'select' as FieldType,
    config: { options: ['todo', 'done'] },
    permissions: VALID_PERMISSIONS,
  };

  it('returns a single FieldDefined draft carrying every field from the input', () => {
    const drafts = defineField(validInput);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldDefined');
    expect(drafts[0]?.payload).toMatchObject({
      fieldDefinitionId: FIELD_DEFINITION_ID,
      workspaceId: WORKSPACE_ID,
      objectType: 'task',
      key: 'status',
      label: 'Status',
      fieldType: 'select',
      config: { options: ['todo', 'done'] },
      permissions: VALID_PERMISSIONS,
    });
  });

  it('accepts an explicit defaultValue that is valid for the field type', () => {
    expect(() => defineField({ ...validInput, defaultValue: 'todo' })).not.toThrow();
  });

  it('throws ValidationError for an unknown objectType', () => {
    expect(() => defineField({ ...validInput, objectType: 'project' as ObjectType })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError for an unknown fieldType', () => {
    expect(() =>
      defineField({ ...validInput, fieldType: 'bogus' as FieldType, config: {} }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError for an invalid config (delegates to validateFieldConfig)', () => {
    // select requires config.options; {} is invalid.
    expect(() => defineField({ ...validInput, config: {} })).toThrow(ValidationError);
  });

  it('throws ValidationError for an invalid defaultValue (delegates to validateFieldValue)', () => {
    expect(() => defineField({ ...validInput, defaultValue: 'not-an-option' })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when permissions is missing a role', () => {
    const incompletePermissions = {
      owner: 'edit',
      admin: 'edit',
      member: 'edit',
    } as unknown as FieldPermissions;

    expect(() => defineField({ ...validInput, permissions: incompletePermissions })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when permissions has an extra unknown role key', () => {
    const withExtra = {
      ...VALID_PERMISSIONS,
      superadmin: 'edit',
    } as unknown as FieldPermissions;

    expect(() => defineField({ ...validInput, permissions: withExtra })).toThrow(ValidationError);
  });

  it('throws ValidationError when permissions has an invalid level string for a role', () => {
    const invalidLevel = {
      ...VALID_PERMISSIONS,
      guest: 'write',
    } as unknown as FieldPermissions;

    expect(() => defineField({ ...validInput, permissions: invalidLevel })).toThrow(
      ValidationError,
    );
  });
});

describe('updateField', () => {
  it('returns a single FieldUpdated draft carrying the provided fields', () => {
    const state = buildFieldDefinitionState();
    const drafts = updateField(state, { label: 'New label' });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldUpdated');
    expect(drafts[0]?.payload).toMatchObject({
      fieldDefinitionId: state.id,
      label: 'New label',
    });
  });

  it('throws InvalidObjectStateError when the field definition is archived', () => {
    const state = buildFieldDefinitionState({ lifecycle: 'archived' });

    expect(() => updateField(state, { label: 'x' })).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an active field definition', () => {
    const state = buildFieldDefinitionState({ lifecycle: 'active' });

    expect(() => updateField(state, { label: 'x' })).not.toThrow();
  });

  it('re-validates a provided config against the registry, throwing ValidationError if invalid', () => {
    const state = buildFieldDefinitionState(); // fieldType: 'select'

    expect(() => updateField(state, { config: {} })).toThrow(ValidationError);
  });

  it('accepts a provided config that is valid for the field type', () => {
    const state = buildFieldDefinitionState();

    expect(() =>
      updateField(state, { config: { options: ['todo', 'in-progress', 'done'] } }),
    ).not.toThrow();
  });

  it('re-validates a provided defaultValue against the registry, throwing ValidationError if invalid', () => {
    const state = buildFieldDefinitionState(); // options: ['todo', 'done']

    expect(() => updateField(state, { defaultValue: 'not-an-option' })).toThrow(ValidationError);
  });

  it('accepts a provided defaultValue that is valid for the field type', () => {
    const state = buildFieldDefinitionState();

    expect(() => updateField(state, { defaultValue: 'done' })).not.toThrow();
  });
});

describe('archiveField', () => {
  it('returns a single FieldArchived draft with the expected payload', () => {
    const state = buildFieldDefinitionState({ lifecycle: 'active' });
    const drafts = archiveField(state);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('FieldArchived');
    expect(drafts[0]?.payload).toEqual({ fieldDefinitionId: state.id });
  });

  it('succeeds from active', () => {
    expect(() => archiveField(buildFieldDefinitionState({ lifecycle: 'active' }))).not.toThrow();
  });

  it('throws InvalidObjectStateError when already archived', () => {
    expect(() => archiveField(buildFieldDefinitionState({ lifecycle: 'archived' }))).toThrow(
      InvalidObjectStateError,
    );
  });
});
