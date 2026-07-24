import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { applyDefaultFieldValues, setFieldValue, setFieldValues } from './field-value-commands.js';

import type { FieldDefinition } from './field-definition.js';
import type { FieldPermissions } from './field-permissions.js';

/**
 * Designed command signatures (must be matched exactly by implementer):
 *
 *   setFieldValue(objectId: string, fieldDefinition: FieldDefinition, value: unknown): FieldEventDraft[]
 *     -> validates value against fieldDefinition.fieldType+config
 *        (delegates to validateFieldValue -> ValidationError if invalid).
 *     -> throws InvalidObjectStateError if fieldDefinition.lifecycle === 'archived'.
 *     -> returns [{ type: 'FieldValueChanged', payload: { objectId, fieldKey: fieldDefinition.key, value } }]
 *
 *   setFieldValues(objectId: string, entries: { fieldDefinition: FieldDefinition; value: unknown }[]): FieldEventDraft[]
 *     -> validates every entry (same rules as setFieldValue); if ANY entry
 *        is invalid, the whole call throws (no partial success).
 *     -> returns ONE flat array of drafts, one per entry, in input order.
 *
 *   applyDefaultFieldValues(objectId: string, fieldDefinitions: FieldDefinition[]): FieldEventDraft[]
 *     -> for each field definition with lifecycle === 'active' AND a
 *        defaultValue that is not undefined, returns a FieldValueChanged
 *        draft using that default (no permission check).
 *     -> fields with no defaultValue, or lifecycle === 'archived', produce
 *        NO draft.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const VALID_PERMISSIONS: FieldPermissions = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'view',
};

function buildFieldDefinitionState(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
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

describe('setFieldValue', () => {
  it('returns a single FieldValueChanged draft with the validated value', () => {
    const def = buildFieldDefinitionState();
    const drafts = setFieldValue(OBJECT_ID, def, 'todo');

    expect(drafts).toEqual([
      {
        type: 'FieldValueChanged',
        payload: { objectId: OBJECT_ID, fieldKey: def.key, value: 'todo' },
      },
    ]);
  });

  it('throws ValidationError for a select value not in the configured options', () => {
    const def = buildFieldDefinitionState();

    expect(() => setFieldValue(OBJECT_ID, def, 'bogus')).toThrow(ValidationError);
  });

  it('throws ValidationError for a number field given a string value (AC #2)', () => {
    const def = buildFieldDefinitionState({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      key: 'points',
      fieldType: 'number',
      config: {},
    });

    expect(() => setFieldValue(OBJECT_ID, def, '42')).toThrow(ValidationError);
  });

  it('throws InvalidObjectStateError when the field definition is archived', () => {
    const def = buildFieldDefinitionState({ lifecycle: 'archived' });

    expect(() => setFieldValue(OBJECT_ID, def, 'todo')).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an active field definition with a valid value', () => {
    const def = buildFieldDefinitionState({ lifecycle: 'active' });

    expect(() => setFieldValue(OBJECT_ID, def, 'todo')).not.toThrow();
  });
});

describe('setFieldValues', () => {
  const selectDef = buildFieldDefinitionState({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    key: 'status',
    fieldType: 'select',
    config: { options: ['todo', 'done'] },
  });
  const textDef = buildFieldDefinitionState({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
    key: 'title',
    fieldType: 'text',
    config: {},
  });
  const numberDef = buildFieldDefinitionState({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
    key: 'points',
    fieldType: 'number',
    config: {},
  });

  it('returns one FieldValueChanged draft per entry, in input order', () => {
    const drafts = setFieldValues(OBJECT_ID, [
      { fieldDefinition: selectDef, value: 'todo' },
      { fieldDefinition: textDef, value: 'Hello' },
    ]);

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toEqual({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'status', value: 'todo' },
    });
    expect(drafts[1]).toEqual({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'title', value: 'Hello' },
    });
  });

  it('throws and accepts nothing when one of several entries is invalid (no partial success)', () => {
    expect(() =>
      setFieldValues(OBJECT_ID, [
        { fieldDefinition: selectDef, value: 'todo' },
        { fieldDefinition: textDef, value: 'Hello' },
        { fieldDefinition: numberDef, value: 'not-a-number' },
      ]),
    ).toThrow(ValidationError);
  });

  it('throws InvalidObjectStateError if any entry targets an archived field definition', () => {
    const archivedDef = buildFieldDefinitionState({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA4',
      key: 'legacy',
      lifecycle: 'archived',
    });

    expect(() =>
      setFieldValues(OBJECT_ID, [
        { fieldDefinition: selectDef, value: 'todo' },
        { fieldDefinition: archivedDef, value: 'anything' },
      ]),
    ).toThrow(InvalidObjectStateError);
  });

  it('returns an empty array for an empty entries list', () => {
    expect(setFieldValues(OBJECT_ID, [])).toEqual([]);
  });
});

describe('applyDefaultFieldValues', () => {
  it('produces one FieldValueChanged draft per active field with a defined defaultValue, skipping others', () => {
    const withDefault = buildFieldDefinitionState({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
      key: 'status',
      fieldType: 'select',
      config: { options: ['todo', 'done'] },
      defaultValue: 'todo',
      lifecycle: 'active',
    });
    const withoutDefault = buildFieldDefinitionState({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
      key: 'title',
      fieldType: 'text',
      config: {},
      defaultValue: undefined,
      lifecycle: 'active',
    });
    const archivedWithDefault = buildFieldDefinitionState({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB3',
      key: 'legacy',
      fieldType: 'text',
      config: {},
      defaultValue: 'x',
      lifecycle: 'archived',
    });

    const drafts = applyDefaultFieldValues(OBJECT_ID, [
      withDefault,
      withoutDefault,
      archivedWithDefault,
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      type: 'FieldValueChanged',
      payload: { objectId: OBJECT_ID, fieldKey: 'status', value: 'todo' },
    });
  });

  it('returns an empty array when no field definitions have a defaultValue', () => {
    const def = buildFieldDefinitionState({ defaultValue: undefined });

    expect(applyDefaultFieldValues(OBJECT_ID, [def])).toEqual([]);
  });

  it('returns an empty array for an empty field definitions list', () => {
    expect(applyDefaultFieldValues(OBJECT_ID, [])).toEqual([]);
  });

  it('applies a falsy-but-defined defaultValue (false), proving the check is "not undefined" not truthiness', () => {
    const checkboxDef = buildFieldDefinitionState({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB4',
      key: 'done',
      fieldType: 'checkbox',
      config: {},
      defaultValue: false,
      lifecycle: 'active',
    });

    const drafts = applyDefaultFieldValues(OBJECT_ID, [checkboxDef]);

    expect(drafts).toEqual([
      {
        type: 'FieldValueChanged',
        payload: { objectId: OBJECT_ID, fieldKey: 'done', value: false },
      },
    ]);
  });
});
