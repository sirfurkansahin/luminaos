import { InvalidObjectStateError } from '@luminaos/shared';

import { validateFieldValue } from './field-type-registry.js';

import type { FieldEventDraft } from './field-commands.js';
import type { FieldDefinition } from './field-definition.js';

/**
 * Validates `value` against `fieldDefinition.fieldType` + `config` and
 * returns a single `FieldValueChanged` draft. Per the F1-T2 plan's central
 * architecture decision, this event is appended to the OBJECT's own event
 * stream (`lumina-object`), not a separate field-value stream — the server
 * layer decides where to append; this pure function only builds the draft.
 */
export function setFieldValue(
  objectId: string,
  fieldDefinition: FieldDefinition,
  value: unknown,
): FieldEventDraft[] {
  if (fieldDefinition.lifecycle === 'archived') {
    throw new InvalidObjectStateError('cannot set a value for an archived field definition', {
      fieldDefinitionId: fieldDefinition.id,
      lifecycle: fieldDefinition.lifecycle,
      attemptedAction: 'setFieldValue',
    });
  }

  validateFieldValue(fieldDefinition.fieldType, fieldDefinition.config, value);

  return [
    {
      type: 'FieldValueChanged',
      payload: { objectId, fieldKey: fieldDefinition.key, value },
    },
  ];
}

/**
 * Validates every entry (same rules as `setFieldValue`) and returns ONE flat
 * array of drafts, in input order. If ANY entry is invalid, the whole call
 * throws before returning anything — `Array.prototype.flatMap` propagates
 * the exception from whichever entry fails without producing a partial
 * result, so there is no separate "validate all, then build" pass needed.
 */
export function setFieldValues(
  objectId: string,
  entries: { fieldDefinition: FieldDefinition; value: unknown }[],
): FieldEventDraft[] {
  return entries.flatMap((entry) => setFieldValue(objectId, entry.fieldDefinition, entry.value));
}

/**
 * For each ACTIVE field definition with a `defaultValue` that is not
 * `undefined`, returns a `FieldValueChanged` draft using that default — no
 * permission check (system-applied at object-creation time).
 */
export function applyDefaultFieldValues(
  objectId: string,
  fieldDefinitions: FieldDefinition[],
): FieldEventDraft[] {
  return fieldDefinitions
    .filter((def) => def.lifecycle === 'active' && def.defaultValue !== undefined)
    .map((def) => ({
      type: 'FieldValueChanged',
      payload: { objectId, fieldKey: def.key, value: def.defaultValue },
    }));
}
