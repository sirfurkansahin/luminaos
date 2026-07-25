import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';
import type { FilterCondition, FilterOperator } from '@luminaos/shared';

import {
  assertGroupableField,
  assertSortableField,
  assertValidFilterCondition,
  getValidOperatorsForField,
} from './filter-operators.js';

import type { FieldDefinition } from '../field-definition.js';
import type { FieldPermissions } from '../field-permissions.js';
import type { FieldType } from '../field-type-registry.js';

/**
 * F1-T6 PR-B (RED step) — "which `FilterOperator`s are valid for which
 * `FieldType`" query-layer rules, built on top of F1-T6 PR-A's
 * `FilterOperator`/`FilterCondition` (`packages/shared/src/query/query-spec.ts`).
 *
 * Designed API (per the approved F1-T6 plan, pinned here as a contract for
 * `implementer`; must be matched exactly), to live at
 * `packages/core-objects/src/fields/query/filter-operators.ts` and be
 * re-exported from `packages/core-objects/src/index.ts`'s barrel:
 *
 *   getValidOperatorsForField(definition: FieldDefinition): readonly FilterOperator[]
 *   assertValidFilterCondition(definition: FieldDefinition, condition: FilterCondition): void
 *   assertGroupableField(definition: FieldDefinition): void
 *   assertSortableField(definition: FieldDefinition): void
 *
 * Expected to fail (red) until `implementer` creates
 * `packages/core-objects/src/fields/query/filter-operators.ts` and wires it
 * into the barrel.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

const VIEW_ONLY_PERMISSIONS: FieldPermissions = {
  owner: 'view',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

function buildField(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'field-id',
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

function buildFieldOfType(fieldType: FieldType, config: unknown = {}): FieldDefinition {
  return buildField({ fieldType, config, key: `${fieldType}Field` });
}

const AI_TEXT_CONFIG = {
  promptTemplate: 'Summarize {notes}',
  sourceFields: ['notes'],
  outputType: 'text' as const,
  refreshMode: 'manual' as const,
};

const AI_SELECT_CONFIG = {
  promptTemplate: 'Classify {notes}',
  sourceFields: ['notes'],
  outputType: 'select' as const,
  refreshMode: 'manual' as const,
  options: ['low', 'medium', 'high'],
};

/** Order-independent equality helper — only operator SET membership is pinned here. */
function expectSameOperatorSet(
  actual: readonly FilterOperator[],
  expected: readonly FilterOperator[],
): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}

describe('getValidOperatorsForField', () => {
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

  const FORMULA_OPERATORS: readonly FilterOperator[] = [
    'equals',
    'notEquals',
    'isEmpty',
    'isNotEmpty',
  ];

  it.each(['text', 'longText', 'url', 'email'] as const)(
    'returns the text-like operator set for "%s"',
    (fieldType) => {
      expectSameOperatorSet(
        getValidOperatorsForField(buildFieldOfType(fieldType)),
        TEXT_LIKE_OPERATORS,
      );
    },
  );

  it.each(['number', 'currency'] as const)(
    'returns the numeric operator set for "%s"',
    (fieldType) => {
      const config = fieldType === 'currency' ? { currencyCode: 'USD' } : {};
      expectSameOperatorSet(
        getValidOperatorsForField(buildFieldOfType(fieldType, config)),
        NUMERIC_OPERATORS,
      );
    },
  );

  it.each(['date', 'datetime'] as const)('returns the date operator set for "%s"', (fieldType) => {
    expectSameOperatorSet(getValidOperatorsForField(buildFieldOfType(fieldType)), DATE_OPERATORS);
  });

  it('returns only "equals" for "checkbox"', () => {
    expectSameOperatorSet(getValidOperatorsForField(buildFieldOfType('checkbox')), ['equals']);
  });

  it('returns the select operator set for "select"', () => {
    const definition = buildFieldOfType('select', { options: ['a', 'b'] });
    expectSameOperatorSet(getValidOperatorsForField(definition), SELECT_OPERATORS);
  });

  it('returns "in"/"notIn"/"isEmpty"/"isNotEmpty" for "multiSelect"', () => {
    const definition = buildFieldOfType('multiSelect', { options: ['a', 'b'] });
    expectSameOperatorSet(getValidOperatorsForField(definition), [
      'in',
      'notIn',
      'isEmpty',
      'isNotEmpty',
    ]);
  });

  it('returns "contains"/"isEmpty"/"isNotEmpty" for "people"', () => {
    expectSameOperatorSet(getValidOperatorsForField(buildFieldOfType('people')), [
      'contains',
      'isEmpty',
      'isNotEmpty',
    ]);
  });

  it('returns the select operator set for "ai" with config.outputType === "select"', () => {
    const definition = buildFieldOfType('ai', AI_SELECT_CONFIG);
    expectSameOperatorSet(getValidOperatorsForField(definition), SELECT_OPERATORS);
  });

  it('returns the text-like operator set for "ai" with config.outputType === "text"', () => {
    const definition = buildFieldOfType('ai', AI_TEXT_CONFIG);
    expectSameOperatorSet(getValidOperatorsForField(definition), TEXT_LIKE_OPERATORS);
  });

  it('returns the type-agnostic-safe operator set for "formula"', () => {
    const definition = buildFieldOfType('formula', { expression: '1 + 1' });
    expectSameOperatorSet(getValidOperatorsForField(definition), FORMULA_OPERATORS);
  });
});

describe('assertValidFilterCondition', () => {
  function condition(field: string, operator: FilterOperator, value?: unknown): FilterCondition {
    return value === undefined ? { field, operator } : { field, operator, value };
  }

  describe('checkbox', () => {
    it('does not throw for the valid "equals" operator', () => {
      const definition = buildFieldOfType('checkbox');
      expect(() =>
        assertValidFilterCondition(definition, condition('checkboxField', 'equals', true)),
      ).not.toThrow();
    });

    it('throws ValidationError for "contains" (the spec-called-out invalid example)', () => {
      const definition = buildFieldOfType('checkbox');
      expect(() =>
        assertValidFilterCondition(definition, condition('checkboxField', 'contains', 'x')),
      ).toThrow(ValidationError);
    });
  });

  describe('select', () => {
    it('does not throw for the valid "in" operator', () => {
      const definition = buildFieldOfType('select', { options: ['a', 'b'] });
      expect(() =>
        assertValidFilterCondition(definition, condition('selectField', 'in', ['a'])),
      ).not.toThrow();
    });

    it('throws ValidationError for the invalid "gt" operator', () => {
      const definition = buildFieldOfType('select', { options: ['a', 'b'] });
      expect(() =>
        assertValidFilterCondition(definition, condition('selectField', 'gt', 'a')),
      ).toThrow(ValidationError);
    });
  });

  describe('number', () => {
    it('does not throw for the valid "between" operator', () => {
      const definition = buildFieldOfType('number');
      expect(() =>
        assertValidFilterCondition(definition, condition('numberField', 'between', [1, 10])),
      ).not.toThrow();
    });

    it('throws ValidationError for the invalid "contains" operator', () => {
      const definition = buildFieldOfType('number');
      expect(() =>
        assertValidFilterCondition(definition, condition('numberField', 'contains', 1)),
      ).toThrow(ValidationError);
    });
  });

  describe('formula', () => {
    it('does not throw for the valid "isEmpty" operator', () => {
      const definition = buildFieldOfType('formula', { expression: '1 + 1' });
      expect(() =>
        assertValidFilterCondition(definition, condition('formulaField', 'isEmpty')),
      ).not.toThrow();
    });

    it('throws ValidationError for the invalid "gt" operator', () => {
      const definition = buildFieldOfType('formula', { expression: '1 + 1' });
      expect(() =>
        assertValidFilterCondition(definition, condition('formulaField', 'gt', 1)),
      ).toThrow(ValidationError);
    });
  });

  describe('ai with outputType "select"', () => {
    it('does not throw for the valid "notIn" operator', () => {
      const definition = buildFieldOfType('ai', AI_SELECT_CONFIG);
      expect(() =>
        assertValidFilterCondition(definition, condition('aiField', 'notIn', ['low'])),
      ).not.toThrow();
    });

    it('throws ValidationError for the invalid "contains" operator', () => {
      const definition = buildFieldOfType('ai', AI_SELECT_CONFIG);
      expect(() =>
        assertValidFilterCondition(definition, condition('aiField', 'contains', 'low')),
      ).toThrow(ValidationError);
    });
  });

  describe('ai with outputType "text"', () => {
    it('does not throw for the valid "contains" operator', () => {
      const definition = buildFieldOfType('ai', AI_TEXT_CONFIG);
      expect(() =>
        assertValidFilterCondition(definition, condition('aiField', 'contains', 'summary')),
      ).not.toThrow();
    });

    it('throws ValidationError for the invalid "in" operator', () => {
      const definition = buildFieldOfType('ai', AI_TEXT_CONFIG);
      expect(() =>
        assertValidFilterCondition(definition, condition('aiField', 'in', ['x'])),
      ).toThrow(ValidationError);
    });
  });
});

describe('assertGroupableField', () => {
  it('does not throw for a "select" field', () => {
    const definition = buildFieldOfType('select', { options: ['a', 'b'] });
    expect(() => assertGroupableField(definition)).not.toThrow();
  });

  it('throws ValidationError for a "multiSelect" field', () => {
    const definition = buildFieldOfType('multiSelect', { options: ['a', 'b'] });
    expect(() => assertGroupableField(definition)).toThrow(ValidationError);
  });

  it('throws ValidationError for a "text" field', () => {
    const definition = buildFieldOfType('text');
    expect(() => assertGroupableField(definition)).toThrow(ValidationError);
  });
});

describe('assertSortableField', () => {
  it.each(['multiSelect', 'people', 'formula', 'ai'] as const)(
    'throws ValidationError for "%s" (no natural total order)',
    (fieldType) => {
      let config: unknown = {};
      if (fieldType === 'multiSelect') config = { options: ['a', 'b'] };
      if (fieldType === 'formula') config = { expression: '1 + 1' };
      if (fieldType === 'ai') config = AI_TEXT_CONFIG;

      const definition = buildFieldOfType(fieldType, config);
      expect(() => assertSortableField(definition)).toThrow(ValidationError);
    },
  );

  it.each(['text', 'number', 'date', 'checkbox', 'select'] as const)(
    'does not throw for "%s"',
    (fieldType) => {
      const config = fieldType === 'select' ? { options: ['a', 'b'] } : {};
      const definition = buildFieldOfType(fieldType, config);
      expect(() => assertSortableField(definition)).not.toThrow();
    },
  );
});
