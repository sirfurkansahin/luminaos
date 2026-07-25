import { describe, expect, it } from 'vitest';

/**
 * Pins that `packages/shared/src/query/index.ts`'s barrel gets wired into
 * the package root barrel (`packages/shared/src/index.ts`), matching how
 * `errors/index.js` and `events/index.js` are already re-exported there —
 * so consumers can `import { querySpecSchema } from '@luminaos/shared'`
 * without reaching into the `query/` subpath.
 */
import { querySpecSchema } from '../index.js';

import type { FilterCondition, FilterOperator, QuerySpec, SortSpec } from '../index.js';

describe('query module re-exported from package root barrel', () => {
  it('exposes querySpecSchema as a zod schema with a safeParse method', () => {
    expect(typeof querySpecSchema.safeParse).toBe('function');
  });

  it('parses a minimal valid spec via the root-barrel-exported schema', () => {
    const result = querySpecSchema.safeParse({ objectType: 'task', filters: [] });
    expect(result.success).toBe(true);
  });

  it('type-only re-exports (QuerySpec, FilterCondition, SortSpec, FilterOperator) are usable as types', () => {
    // This is a compile-time assertion: if any of these types are not
    // re-exported from the root barrel, this file fails to type-check.
    const condition: FilterCondition = { field: 'title', operator: 'equals', value: 'x' };
    const sort: SortSpec = { field: 'createdAt', direction: 'asc' };
    const operator: FilterOperator = 'equals';
    const spec: QuerySpec = { objectType: 'task', filters: [condition], sort: [sort] };

    expect(operator).toBe('equals');
    expect(spec.filters).toHaveLength(1);
  });
});
