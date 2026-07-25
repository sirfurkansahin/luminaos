import { describe, expect, it } from 'vitest';

import {
  FILTER_OPERATORS,
  filterConditionSchema,
  filterOperatorSchema,
  querySpecSchema,
  sortSpecSchema,
} from './query-spec.js';

/**
 * A minimal-but-representative valid `FilterCondition`. Individual tests
 * override fields as needed.
 */
function validFilterCondition(): Record<string, unknown> {
  return { field: 'title', operator: 'equals', value: 'hello' };
}

function validSortSpec(): Record<string, unknown> {
  return { field: 'createdAt', direction: 'asc' };
}

/**
 * A minimal valid `QuerySpec`: `filters` is required but may be empty — "no
 * filters" is itself a valid query (return everything, subject to
 * pagination).
 */
function minimalQuerySpec(): Record<string, unknown> {
  return { objectType: 'task', filters: [] };
}

function fullyPopulatedQuerySpec(): Record<string, unknown> {
  return {
    objectType: 'task',
    filters: [validFilterCondition()],
    sort: [validSortSpec()],
    group: 'status',
    cursor: 'opaque-cursor-token',
    limit: 50,
  };
}

describe('FILTER_OPERATORS / filterOperatorSchema', () => {
  const expectedOperators = [
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'before',
    'after',
    'in',
    'notIn',
    'isEmpty',
    'isNotEmpty',
  ] as const;

  it('contains exactly the 15 documented operator literals, in order', () => {
    expect([...FILTER_OPERATORS]).toEqual(expectedOperators);
  });

  it('has exactly 15 entries', () => {
    expect(FILTER_OPERATORS.length).toBe(15);
  });

  for (const operator of expectedOperators) {
    it(`filterOperatorSchema accepts "${operator}"`, () => {
      const result = filterOperatorSchema.safeParse(operator);
      expect(result.success).toBe(true);
    });
  }

  it('filterOperatorSchema rejects a string outside the enum', () => {
    const result = filterOperatorSchema.safeParse('startsWith');
    expect(result.success).toBe(false);
  });

  it('filterOperatorSchema rejects a non-string value', () => {
    const result = filterOperatorSchema.safeParse(42);
    expect(result.success).toBe(false);
  });
});

describe('filterConditionSchema', () => {
  it('parses a valid condition using "equals"', () => {
    const result = filterConditionSchema.safeParse(validFilterCondition());
    expect(result.success).toBe(true);
  });

  it('parses a valid condition using "contains"', () => {
    const result = filterConditionSchema.safeParse({
      field: 'description',
      operator: 'contains',
      value: 'urgent',
    });
    expect(result.success).toBe(true);
  });

  it('parses a valid condition using "between"', () => {
    const result = filterConditionSchema.safeParse({
      field: 'dueDate',
      operator: 'between',
      value: ['2026-01-01', '2026-12-31'],
    });
    expect(result.success).toBe(true);
  });

  it('parses a valid condition using "isEmpty" with no value at all', () => {
    const result = filterConditionSchema.safeParse({ field: 'assignee', operator: 'isEmpty' });
    expect(result.success).toBe(true);
  });

  it('parses a valid condition using "isNotEmpty" with no value at all', () => {
    const result = filterConditionSchema.safeParse({
      field: 'assignee',
      operator: 'isNotEmpty',
    });
    expect(result.success).toBe(true);
  });

  describe('field', () => {
    it('rejects an empty field', () => {
      const result = filterConditionSchema.safeParse({ ...validFilterCondition(), field: '' });
      expect(result.success).toBe(false);
    });

    it('rejects a field longer than 200 characters', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        field: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('accepts a field exactly 200 characters long', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        field: 'a'.repeat(200),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('operator', () => {
    it('rejects an unknown operator string', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        operator: 'startsWith',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a missing operator', () => {
      const condition = validFilterCondition();
      delete condition.operator;
      const result = filterConditionSchema.safeParse(condition);
      expect(result.success).toBe(false);
    });
  });

  describe('value (no shape validation at this layer)', () => {
    it('accepts value omitted entirely', () => {
      const condition = validFilterCondition();
      delete condition.value;
      const result = filterConditionSchema.safeParse(condition);
      expect(result.success).toBe(true);
    });

    it('accepts a null value', () => {
      const result = filterConditionSchema.safeParse({ ...validFilterCondition(), value: null });
      expect(result.success).toBe(true);
    });

    it('accepts a string value', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        value: 'a string',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a number value', () => {
      const result = filterConditionSchema.safeParse({ ...validFilterCondition(), value: 42 });
      expect(result.success).toBe(true);
    });

    it('accepts an array value', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        value: ['a', 'b', 'c'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a boolean value', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        value: true,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('strict mode (mass-assignment protection)', () => {
    it('rejects a condition with an unknown extra top-level key', () => {
      const result = filterConditionSchema.safeParse({
        ...validFilterCondition(),
        extra: 'nope',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('missing required fields', () => {
    it('rejects a condition missing "field"', () => {
      const condition = validFilterCondition();
      delete condition.field;
      const result = filterConditionSchema.safeParse(condition);
      expect(result.success).toBe(false);
    });
  });
});

describe('sortSpecSchema', () => {
  it('parses a valid "asc" sort spec', () => {
    const result = sortSpecSchema.safeParse({ field: 'createdAt', direction: 'asc' });
    expect(result.success).toBe(true);
  });

  it('parses a valid "desc" sort spec', () => {
    const result = sortSpecSchema.safeParse({ field: 'createdAt', direction: 'desc' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid direction string', () => {
    const result = sortSpecSchema.safeParse({ field: 'createdAt', direction: 'ascending' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty field', () => {
    const result = sortSpecSchema.safeParse({ field: '', direction: 'asc' });
    expect(result.success).toBe(false);
  });

  it('rejects a field longer than 200 characters', () => {
    const result = sortSpecSchema.safeParse({ field: 'a'.repeat(201), direction: 'asc' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing direction', () => {
    const spec = validSortSpec();
    delete spec.direction;
    const result = sortSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra top-level key (.strict())', () => {
    const result = sortSpecSchema.safeParse({ ...validSortSpec(), extra: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('querySpecSchema', () => {
  it('parses a minimal valid spec ({ objectType, filters: [] })', () => {
    const result = querySpecSchema.safeParse(minimalQuerySpec());
    expect(result.success).toBe(true);
  });

  describe('objectType', () => {
    it('rejects an empty objectType', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), objectType: '' });
      expect(result.success).toBe(false);
    });

    it('rejects an objectType longer than 100 characters', () => {
      const result = querySpecSchema.safeParse({
        ...minimalQuerySpec(),
        objectType: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it('accepts an objectType exactly 100 characters long', () => {
      const result = querySpecSchema.safeParse({
        ...minimalQuerySpec(),
        objectType: 'a'.repeat(100),
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing objectType', () => {
      const spec = minimalQuerySpec();
      delete spec.objectType;
      const result = querySpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
    });
  });

  describe('filters (required, may be empty)', () => {
    it('rejects a spec with "filters" missing entirely', () => {
      const spec = minimalQuerySpec();
      delete spec.filters;
      const result = querySpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
    });

    it('accepts an empty filters array', () => {
      const result = querySpecSchema.safeParse({ objectType: 'task', filters: [] });
      expect(result.success).toBe(true);
    });

    it('accepts a filters array with valid conditions', () => {
      const result = querySpecSchema.safeParse({
        objectType: 'task',
        filters: [
          validFilterCondition(),
          { field: 'status', operator: 'notEquals', value: 'done' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a filters array with exactly 50 entries', () => {
      const filters = Array.from({ length: 50 }, (_, i) => ({
        field: `field-${String(i)}`,
        operator: 'equals' as const,
        value: i,
      }));
      const result = querySpecSchema.safeParse({ objectType: 'task', filters });
      expect(result.success).toBe(true);
    });

    it('rejects a filters array with more than 50 entries', () => {
      const filters = Array.from({ length: 51 }, (_, i) => ({
        field: `field-${String(i)}`,
        operator: 'equals' as const,
        value: i,
      }));
      const result = querySpecSchema.safeParse({ objectType: 'task', filters });
      expect(result.success).toBe(false);
    });

    it('rejects a filters array containing an invalid condition', () => {
      const result = querySpecSchema.safeParse({
        objectType: 'task',
        filters: [{ field: '', operator: 'equals', value: 1 }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('sort (optional)', () => {
    it('accepts a spec with sort omitted', () => {
      const result = querySpecSchema.safeParse(minimalQuerySpec());
      expect(result.success).toBe(true);
    });

    it('accepts a sort array with valid entries', () => {
      const result = querySpecSchema.safeParse({
        ...minimalQuerySpec(),
        sort: [validSortSpec(), { field: 'title', direction: 'desc' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a sort array with exactly 10 entries', () => {
      const sort = Array.from({ length: 10 }, (_, i) => ({
        field: `field-${String(i)}`,
        direction: 'asc' as const,
      }));
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), sort });
      expect(result.success).toBe(true);
    });

    it('rejects a sort array with more than 10 entries', () => {
      const sort = Array.from({ length: 11 }, (_, i) => ({
        field: `field-${String(i)}`,
        direction: 'asc' as const,
      }));
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), sort });
      expect(result.success).toBe(false);
    });
  });

  describe('group (optional)', () => {
    it('accepts a spec with group omitted', () => {
      const result = querySpecSchema.safeParse(minimalQuerySpec());
      expect(result.success).toBe(true);
    });

    it('accepts a valid non-empty group', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), group: 'status' });
      expect(result.success).toBe(true);
    });

    it('rejects an empty group when present', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), group: '' });
      expect(result.success).toBe(false);
    });

    it('rejects a group longer than 200 characters', () => {
      const result = querySpecSchema.safeParse({
        ...minimalQuerySpec(),
        group: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('cursor (optional, opaque)', () => {
    it('accepts a spec with cursor omitted', () => {
      const result = querySpecSchema.safeParse(minimalQuerySpec());
      expect(result.success).toBe(true);
    });

    it('accepts an arbitrary non-empty cursor string', () => {
      const result = querySpecSchema.safeParse({
        ...minimalQuerySpec(),
        cursor: 'anything-goes-here==',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an empty cursor string', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), cursor: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('limit (optional, bounded positive integer)', () => {
    it('accepts a spec with limit omitted', () => {
      const result = querySpecSchema.safeParse(minimalQuerySpec());
      expect(result.success).toBe(true);
    });

    it('accepts limit: 1', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), limit: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts limit: 200 (the documented cap)', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), limit: 200 });
      expect(result.success).toBe(true);
    });

    it('rejects limit: 0', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), limit: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects a negative limit', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), limit: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects a non-integer limit', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), limit: 3.5 });
      expect(result.success).toBe(false);
    });

    it('rejects a limit above the documented cap (201)', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), limit: 201 });
      expect(result.success).toBe(false);
    });
  });

  describe('strict mode (mass-assignment protection)', () => {
    it('rejects a spec with an unknown extra top-level key', () => {
      const result = querySpecSchema.safeParse({ ...minimalQuerySpec(), extra: 'nope' });
      expect(result.success).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('parses a fully-populated valid spec unchanged', () => {
      const spec = fullyPopulatedQuerySpec();
      const parsed = querySpecSchema.parse(spec);
      expect(parsed).toEqual(spec);
    });
  });
});
