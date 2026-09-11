import { describe, expect, it } from 'vitest';

import type { QuerySpec } from '@luminaos/shared';

import { deriveWidgetColumns, MAX_WIDGET_TABLE_COLUMNS } from './derive-widget-columns.js';

/**
 * F3-T8 PR1 (RED step), ADR-0042 Karar (g) — `packages/artifacts/src/derive-widget-columns.ts`.
 *
 *   export const MAX_WIDGET_TABLE_COLUMNS = 8;
 *   export function deriveWidgetColumns(querySpec: QuerySpec): string[];
 *     // referenced = ['title', ...filters[].field, ...(sort ?? []).map(s => s.field)]
 *     // return Array.from(new Set(referenced)).slice(0, MAX_WIDGET_TABLE_COLUMNS);
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/derive-widget-columns.ts` — this module does not
 * exist yet at all, so this import fails with "Cannot find module".
 */

function buildQuerySpec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    objectType: 'task',
    filters: [],
    ...overrides,
  };
}

describe('MAX_WIDGET_TABLE_COLUMNS', () => {
  it('is exactly 8 (ADR-0042 Karar g/h)', () => {
    expect(MAX_WIDGET_TABLE_COLUMNS).toBe(8);
  });
});

describe('deriveWidgetColumns — "title" is always the first column', () => {
  it('places "title" first even when no filter/sort references a field literally named "title"', () => {
    const querySpec = buildQuerySpec({
      filters: [{ field: 'status', operator: 'equals', value: 'done' }],
      sort: [{ field: 'dueDate', direction: 'asc' }],
    });

    const columns = deriveWidgetColumns(querySpec);

    expect(columns[0]).toBe('title');
  });

  it('returns ["title"] alone for a querySpec with empty filters and no sort at all', () => {
    const querySpec = buildQuerySpec({ filters: [] });

    expect(deriveWidgetColumns(querySpec)).toEqual(['title']);
  });

  it('returns at least ["title"] for a querySpec with empty filters and an explicitly empty sort array', () => {
    const querySpec = buildQuerySpec({ filters: [], sort: [] });

    expect(deriveWidgetColumns(querySpec)).toEqual(['title']);
  });
});

describe('deriveWidgetColumns — columns from filters/sort, deduplicated', () => {
  it('includes fields referenced by filters, after "title"', () => {
    const querySpec = buildQuerySpec({
      filters: [
        { field: 'status', operator: 'equals', value: 'done' },
        { field: 'assignee', operator: 'equals', value: 'x' },
      ],
    });

    expect(deriveWidgetColumns(querySpec)).toEqual(['title', 'status', 'assignee']);
  });

  it('includes fields referenced by sort, after "title" and filter fields', () => {
    const querySpec = buildQuerySpec({
      filters: [{ field: 'status', operator: 'equals', value: 'done' }],
      sort: [{ field: 'dueDate', direction: 'asc' }],
    });

    expect(deriveWidgetColumns(querySpec)).toEqual(['title', 'status', 'dueDate']);
  });

  it('dedups a field referenced by BOTH a filter AND a sort into a single column entry', () => {
    const querySpec = buildQuerySpec({
      filters: [{ field: 'status', operator: 'equals', value: 'done' }],
      sort: [{ field: 'status', direction: 'asc' }],
    });

    expect(deriveWidgetColumns(querySpec)).toEqual(['title', 'status']);
  });
});

describe('deriveWidgetColumns — truncation to MAX_WIDGET_TABLE_COLUMNS', () => {
  it('truncates to exactly MAX_WIDGET_TABLE_COLUMNS (8) total columns when more than 7 distinct fields are referenced (title takes 1 slot)', () => {
    const querySpec = buildQuerySpec({
      filters: Array.from({ length: 10 }, (_, i) => ({
        field: `field${String(i + 1)}`,
        operator: 'equals' as const,
        value: 'x',
      })),
    });

    const columns = deriveWidgetColumns(querySpec);

    expect(columns).toHaveLength(MAX_WIDGET_TABLE_COLUMNS);
    expect(columns).toEqual([
      'title',
      'field1',
      'field2',
      'field3',
      'field4',
      'field5',
      'field6',
      'field7',
    ]);
  });

  it('does not truncate when exactly MAX_WIDGET_TABLE_COLUMNS - 1 distinct fields are referenced (title + 7 fields = 8 total, no truncation needed)', () => {
    const querySpec = buildQuerySpec({
      filters: Array.from({ length: 7 }, (_, i) => ({
        field: `field${String(i + 1)}`,
        operator: 'equals' as const,
        value: 'x',
      })),
    });

    const columns = deriveWidgetColumns(querySpec);

    expect(columns).toHaveLength(MAX_WIDGET_TABLE_COLUMNS);
    expect(columns).toEqual([
      'title',
      'field1',
      'field2',
      'field3',
      'field4',
      'field5',
      'field6',
      'field7',
    ]);
  });
});

describe('deriveWidgetColumns — stable/deterministic order across distinct fixtures (exact array equality, not just membership)', () => {
  it('produces the exact same order for the same input across repeated calls', () => {
    const querySpec = buildQuerySpec({
      filters: [
        { field: 'priority', operator: 'equals', value: 'high' },
        { field: 'assignee', operator: 'equals', value: 'bob' },
      ],
      sort: [{ field: 'dueDate', direction: 'desc' }],
    });

    const first = deriveWidgetColumns(querySpec);
    const second = deriveWidgetColumns(querySpec);

    expect(first).toEqual(['title', 'priority', 'assignee', 'dueDate']);
    expect(second).toEqual(first);
  });

  it('produces the exact expected order for a second, distinct non-trivial fixture (filter+sort overlap)', () => {
    const querySpec = buildQuerySpec({
      filters: [{ field: 'status', operator: 'equals', value: 'open' }],
      sort: [
        { field: 'createdAt', direction: 'asc' },
        { field: 'status', direction: 'asc' },
      ],
    });

    expect(deriveWidgetColumns(querySpec)).toEqual(['title', 'status', 'createdAt']);
  });
});
