import { ValidationError } from '@luminaos/shared';
import type { FilterCondition, FilterOperator } from '@luminaos/shared';

import { aiConfigSchema } from '../field-type-registry.js';

import type { FieldDefinition } from '../field-definition.js';
import type { FieldType } from '../field-type-registry.js';

/**
 * F1-T6 PR-B: which `FilterOperator`s (from `packages/shared`'s F1-T6 PR-A
 * `FILTER_OPERATORS`) are valid for which `FieldType`. Per the F1-T6 spec
 * (`docs/specs/F1-E2/F1-T6-sorgu-katmani.md` §2): "text→contains/equals,
 * number/currency→gt/lt/between, date/datetime→before/after/between,
 * select→in/notIn, checkbox→equals". Groupings below share an operator table
 * where the underlying value shape is the same (e.g. `url`/`email` are
 * string-shaped like `text`; `currency` is number-shaped like `number`).
 */

const TEXT_LIKE_OPERATORS: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'isEmpty',
  'isNotEmpty',
];

const NUMERIC_OPERATORS: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
];

const DATE_OPERATORS: readonly FilterOperator[] = [
  'equals',
  'before',
  'after',
  'between',
  'isEmpty',
  'isNotEmpty',
];

const SELECT_OPERATORS: readonly FilterOperator[] = ['equals', 'notEquals', 'in', 'notIn'];

const CHECKBOX_OPERATORS: readonly FilterOperator[] = ['equals'];

const MULTI_SELECT_OPERATORS: readonly FilterOperator[] = ['in', 'notIn', 'isEmpty', 'isNotEmpty'];

const PEOPLE_OPERATORS: readonly FilterOperator[] = ['contains', 'isEmpty', 'isNotEmpty'];

/**
 * `formula` fields are always computed (per `assertFormulaFieldRules` in
 * `field-commands.ts`, they can never be directly edited) and their result
 * type is opaque to this query layer — restrict them to the type-agnostic
 * operators that make sense for any computed scalar.
 */
const FORMULA_OPERATORS: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'isEmpty',
  'isNotEmpty',
];

/**
 * `ai` fields' valid operator set depends on `config.outputType` ('text' |
 * 'select') — the SAME conditional `field-type-registry.ts`'s own
 * `buildValueSchema` already branches on for 'ai'. `config` is re-parsed
 * here (via the same exported `aiConfigSchema` `buildValueSchema` uses)
 * rather than trusted as pre-validated, so an invalid config surfaces the
 * same way (a `ValidationError`) here as it does at write time.
 */
function getAIOperators(config: unknown): readonly FilterOperator[] {
  const result = aiConfigSchema.safeParse(config);

  if (!result.success) {
    throw new ValidationError('invalid field config', {
      fieldType: 'ai',
      issues: result.error.issues,
    });
  }

  return result.data.outputType === 'select' ? SELECT_OPERATORS : TEXT_LIKE_OPERATORS;
}

/**
 * Returns the full set of `FilterOperator`s valid for `definition`'s
 * `fieldType` (and, for `ai`, its `config.outputType`).
 */
export function getValidOperatorsForField(definition: FieldDefinition): readonly FilterOperator[] {
  const fieldType: FieldType = definition.fieldType;

  switch (fieldType) {
    case 'text':
    case 'longText':
    case 'url':
    case 'email':
      return TEXT_LIKE_OPERATORS;
    case 'number':
    case 'currency':
      return NUMERIC_OPERATORS;
    case 'date':
    case 'datetime':
      return DATE_OPERATORS;
    case 'checkbox':
      return CHECKBOX_OPERATORS;
    case 'select':
      return SELECT_OPERATORS;
    case 'multiSelect':
      return MULTI_SELECT_OPERATORS;
    case 'people':
      return PEOPLE_OPERATORS;
    case 'formula':
      return FORMULA_OPERATORS;
    case 'ai':
      return getAIOperators(definition.config);
  }
}

/**
 * Throws `ValidationError` if `condition.operator` is not a valid operator
 * for `definition`'s field type (e.g. `contains` against a `checkbox`
 * field) — the spec-called-out example from
 * `docs/specs/F1-E2/F1-T6-sorgu-katmani.md` §2. Returns `true` (not `void`)
 * on success — same reasoning as `field-type-registry.ts`'s
 * `validateFieldConfig`/`validateFieldValue`: keeps this test file's
 * `expect(() => assertValidFilterCondition(...)).not.toThrow()`
 * shorthand-arrow call sites free of
 * `@typescript-eslint/no-confusing-void-expression`.
 */
export function assertValidFilterCondition(
  definition: FieldDefinition,
  condition: FilterCondition,
): true {
  const validOperators = getValidOperatorsForField(definition);

  if (!validOperators.includes(condition.operator)) {
    throw new ValidationError('operator is not valid for this field type', {
      fieldType: definition.fieldType,
      operator: condition.operator,
    });
  }

  return true;
}

/**
 * Per the F1-T6 spec (§5): grouping is only defined for `select`-typed
 * fields — the group key must be a single, finite, discrete value per
 * object (a `select`'s one-of-`options` value), which `group` results in
 * `{ groupValue, count, items[] }` shape. Every other field type (including
 * `multiSelect`, which is discrete but multi-valued per object) is rejected.
 */
export function assertGroupableField(definition: FieldDefinition): true {
  if (definition.fieldType !== 'select') {
    throw new ValidationError('field type is not groupable', {
      fieldType: definition.fieldType,
    });
  }

  return true;
}

/**
 * Field types with no natural total order, or whose values are not a single
 * scalar (arrays, or opaque computed results), cannot be sorted on.
 * `multiSelect`/`people` are array-valued; `formula`/`ai` results are
 * computed and their shape is not pinned by this query layer (see
 * `FORMULA_OPERATORS`'s doc comment above).
 */
const NOT_SORTABLE_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'multiSelect',
  'people',
  'formula',
  'ai',
]);

/**
 * Throws `ValidationError` if `definition`'s field type has no natural total
 * order and therefore cannot be used as a sort key.
 */
export function assertSortableField(definition: FieldDefinition): true {
  if (NOT_SORTABLE_FIELD_TYPES.has(definition.fieldType)) {
    throw new ValidationError('field type has no natural total order and cannot be sorted', {
      fieldType: definition.fieldType,
    });
  }

  return true;
}
