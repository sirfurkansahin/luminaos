import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { isKnownObjectType } from '../object-type-registry.js';
import { isValidFieldPermissions } from './field-permissions.js';
import {
  formulaConfigSchema,
  isKnownFieldType,
  validateFieldConfig,
  validateFieldValue,
} from './field-type-registry.js';
import { findFormulaCycle } from './formula/formula-graph.js';
import { parseFormula } from './formula/parser.js';

import type { FieldDefinition } from './field-definition.js';
import type { FieldPermissions } from './field-permissions.js';
import type { FieldType } from './field-type-registry.js';
import type { ObjectType } from '../lumina-object.js';

/**
 * A draft of a field-definition domain event, not yet wrapped into the
 * F0-T6 `NewDomainEvent` envelope — same shape as F1-T1's `ObjectEventDraft`
 * (that wrapping is the server layer's job).
 */
export interface FieldEventDraft {
  type: string;
  payload: Record<string, unknown>;
}

export interface DefineFieldInput {
  fieldDefinitionId: string;
  workspaceId: string;
  objectType: ObjectType;
  key: string;
  label: string;
  fieldType: FieldType;
  config: unknown;
  defaultValue?: unknown;
  permissions: FieldPermissions;
}

export interface UpdateFieldInput {
  label?: string;
  config?: unknown;
  defaultValue?: unknown;
  permissions?: FieldPermissions;
}

function assertValidPermissions(permissions: unknown): asserts permissions is FieldPermissions {
  if (!isValidFieldPermissions(permissions)) {
    throw new ValidationError('permissions must cover exactly the 4 roles with a valid level', {
      permissions,
    });
  }
}

/**
 * A field's `key` ends up used as a plain-object property name throughout
 * this codebase (field-value maps in `apps/server`, formula `{fieldKey}`
 * lookups in the expression evaluator) — reject the handful of names that
 * would let a `key:value` assignment reinterpret an object's own prototype
 * chain rather than set an ordinary own property (security review finding,
 * F1-T4).
 */
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeFieldKey(key: string): void {
  if (RESERVED_FIELD_KEYS.has(key)) {
    throw new ValidationError('field key is reserved and cannot be used', { key });
  }
}

/**
 * Per F1-T4 plan: a formula field's value is always computed, never
 * directly editable/defaultable. Also validates (when `config` is being
 * set) that every field the expression references is known, and that
 * accepting it would not close a formula-to-formula dependency cycle.
 */
function assertFormulaFieldRules(options: {
  candidateKey: string;
  objectType: ObjectType;
  config: unknown;
  configProvided: boolean;
  defaultValueProvided: boolean;
  permissions: FieldPermissions | undefined;
  permissionsProvided: boolean;
  existingFieldDefinitions: FieldDefinition[];
}): void {
  if (options.defaultValueProvided) {
    throw new ValidationError('formula fields cannot have a defaultValue');
  }

  if (options.permissionsProvided && options.permissions !== undefined) {
    const grantsEdit = Object.values(options.permissions).some((level) => level === 'edit');

    if (grantsEdit) {
      throw new ValidationError('formula fields cannot be directly edited');
    }
  }

  if (!options.configProvided) {
    return;
  }

  const sameObjectType = options.existingFieldDefinitions.filter(
    (field) => field.objectType === options.objectType,
  );

  const { expression } = formulaConfigSchema.parse(options.config);
  const { dependsOn } = parseFormula(expression);

  const knownKeys = new Set(sameObjectType.map((field) => field.key));

  for (const dependencyKey of dependsOn) {
    if (!knownKeys.has(dependencyKey)) {
      throw new ValidationError('formula references an unknown field', { key: dependencyKey });
    }
  }

  const existingFormulaFields = sameObjectType
    .filter((field) => field.fieldType === 'formula')
    .map((field) => {
      const { expression: existingExpression } = formulaConfigSchema.parse(field.config);
      return { key: field.key, dependsOn: parseFormula(existingExpression).dependsOn };
    });

  const cycle = findFormulaCycle(existingFormulaFields, options.candidateKey, dependsOn);

  if (cycle) {
    throw new ValidationError('formula field would create a dependency cycle', { cycle });
  }
}

export function defineField(
  input: DefineFieldInput,
  existingFieldDefinitions: FieldDefinition[] = [],
): FieldEventDraft[] {
  const objectType: string = input.objectType;

  if (!isKnownObjectType(objectType)) {
    throw new ValidationError('unknown object type', { objectType });
  }

  const fieldType: string = input.fieldType;

  if (!isKnownFieldType(fieldType)) {
    throw new ValidationError('unknown field type', { fieldType });
  }

  assertSafeFieldKey(input.key);

  validateFieldConfig(input.fieldType, input.config);

  if (input.defaultValue !== undefined) {
    validateFieldValue(input.fieldType, input.config, input.defaultValue);
  }

  assertValidPermissions(input.permissions);

  if (input.fieldType === 'formula') {
    assertFormulaFieldRules({
      candidateKey: input.key,
      objectType: input.objectType,
      config: input.config,
      configProvided: true,
      defaultValueProvided: input.defaultValue !== undefined,
      permissions: input.permissions,
      permissionsProvided: true,
      existingFieldDefinitions,
    });
  }

  return [
    {
      type: 'FieldDefined',
      payload: {
        fieldDefinitionId: input.fieldDefinitionId,
        workspaceId: input.workspaceId,
        objectType: input.objectType,
        key: input.key,
        label: input.label,
        fieldType: input.fieldType,
        config: input.config,
        defaultValue: input.defaultValue,
        permissions: input.permissions,
      },
    },
  ];
}

export function updateField(
  state: FieldDefinition,
  input: UpdateFieldInput,
  existingFieldDefinitions: FieldDefinition[] = [],
): FieldEventDraft[] {
  if (state.lifecycle === 'archived') {
    throw new InvalidObjectStateError('cannot update an archived field definition', {
      fieldDefinitionId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'update',
    });
  }

  const effectiveConfig = input.config !== undefined ? input.config : state.config;

  if (input.config !== undefined) {
    validateFieldConfig(state.fieldType, input.config);
  }

  if (input.defaultValue !== undefined) {
    validateFieldValue(state.fieldType, effectiveConfig, input.defaultValue);
  }

  if (input.permissions !== undefined) {
    assertValidPermissions(input.permissions);
  }

  if (state.fieldType === 'formula') {
    assertFormulaFieldRules({
      candidateKey: state.key,
      objectType: state.objectType,
      config: effectiveConfig,
      configProvided: input.config !== undefined,
      defaultValueProvided: input.defaultValue !== undefined,
      permissions: input.permissions,
      permissionsProvided: input.permissions !== undefined,
      existingFieldDefinitions,
    });
  }

  const payload: Record<string, unknown> = { fieldDefinitionId: state.id };

  if (input.label !== undefined) {
    payload.label = input.label;
  }

  if (input.config !== undefined) {
    payload.config = input.config;
  }

  if (input.defaultValue !== undefined) {
    payload.defaultValue = input.defaultValue;
  }

  if (input.permissions !== undefined) {
    payload.permissions = input.permissions;
  }

  return [{ type: 'FieldUpdated', payload }];
}

export function archiveField(state: FieldDefinition): FieldEventDraft[] {
  if (state.lifecycle === 'archived') {
    throw new InvalidObjectStateError('field definition is already archived', {
      fieldDefinitionId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'archive',
    });
  }

  return [{ type: 'FieldArchived', payload: { fieldDefinitionId: state.id } }];
}
