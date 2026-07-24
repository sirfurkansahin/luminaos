import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { isKnownObjectType } from '../object-type-registry.js';
import { isValidFieldPermissions } from './field-permissions.js';
import {
  isKnownFieldType,
  validateFieldConfig,
  validateFieldValue,
} from './field-type-registry.js';

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

export function defineField(input: DefineFieldInput): FieldEventDraft[] {
  const objectType: string = input.objectType;

  if (!isKnownObjectType(objectType)) {
    throw new ValidationError('unknown object type', { objectType });
  }

  const fieldType: string = input.fieldType;

  if (!isKnownFieldType(fieldType)) {
    throw new ValidationError('unknown field type', { fieldType });
  }

  validateFieldConfig(input.fieldType, input.config);

  if (input.defaultValue !== undefined) {
    validateFieldValue(input.fieldType, input.config, input.defaultValue);
  }

  assertValidPermissions(input.permissions);

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

export function updateField(state: FieldDefinition, input: UpdateFieldInput): FieldEventDraft[] {
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
