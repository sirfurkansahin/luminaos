import { describe, expect, it } from 'vitest';

import { getAffectedFormulaKeysInOrder } from './formula-recompute-order.js';

/**
 * F1-T4 PR-B (RED step) — incremental recompute: which formula fields are
 * affected by a set of changed field keys, and in what order they must be
 * evaluated so each dependency is computed before its dependents.
 *
 * Designed signature (must be matched exactly by implementer):
 *
 *   interface FormulaFieldDependency {
 *     key: string;
 *     dependsOn: readonly string[];
 *   }
 *
 *   getAffectedFormulaKeysInOrder(
 *     formulaFields: readonly FormulaFieldDependency[],
 *     changedKeys: readonly string[],
 *   ): string[]
 *
 *     -> only the keys from `formulaFields` reachable (transitively, via
 *        `dependsOn` edges) from `changedKeys` are included; anything
 *        unrelated is omitted entirely.
 *     -> the returned array is in a valid topological order: for any two
 *        affected keys A and B where A.dependsOn includes B, B appears
 *        before A.
 *     -> [] when nothing is affected.
 *     -> must not hang/infinite-loop even on a cyclic input graph (cycle
 *        prevention is `findFormulaCycle`'s job at definition time, not
 *        this function's).
 *     -> pure, synchronous, framework-free; must stay reasonably fast on
 *        ~1000-node chains (this does strictly more work than
 *        `findFormulaCycle` -- reverse-reachability plus a topological
 *        sort -- so budget more than the "1000 node chain < 50ms" figure
 *        used for pure cycle detection: <100ms here).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/core-objects/src/fields/formula/formula-recompute-order.ts`.
 */

describe('getAffectedFormulaKeysInOrder', () => {
  it('returns [] when there are no formula fields at all', () => {
    expect(getAffectedFormulaKeysInOrder([], ['price'])).toEqual([]);
    expect(getAffectedFormulaKeysInOrder([], [])).toEqual([]);
  });

  it('returns the directly affected formula field when a key it depends on changed', () => {
    const formulaFields = [{ key: 'total', dependsOn: ['price', 'qty'] }];

    expect(getAffectedFormulaKeysInOrder(formulaFields, ['price'])).toEqual(['total']);
  });

  it('returns [] when the changed key has no relation to any formula field', () => {
    const formulaFields = [{ key: 'total', dependsOn: ['price', 'qty'] }];

    expect(getAffectedFormulaKeysInOrder(formulaFields, ['unrelated'])).toEqual([]);
  });

  it('follows a three-level dependency chain and orders dependencies before dependents', () => {
    const formulaFields = [
      { key: 'subtotal', dependsOn: ['price', 'qty'] },
      { key: 'discounted', dependsOn: ['subtotal'] },
      { key: 'total', dependsOn: ['discounted'] },
    ];

    const result = getAffectedFormulaKeysInOrder(formulaFields, ['price']);

    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining(['subtotal', 'discounted', 'total']));
    expect(result.indexOf('subtotal')).toBeLessThan(result.indexOf('discounted'));
    expect(result.indexOf('discounted')).toBeLessThan(result.indexOf('total'));
  });

  it('handles a diamond-shaped dependency graph, ordering the join node after both branches', () => {
    const formulaFields = [
      { key: 'a', dependsOn: ['x'] },
      { key: 'b', dependsOn: ['x'] },
      { key: 'c', dependsOn: ['a', 'b'] },
    ];

    const result = getAffectedFormulaKeysInOrder(formulaFields, ['x']);

    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('c'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'));
  });

  it('excludes formula fields unrelated to the changed keys while including the affected ones', () => {
    const formulaFields = [
      { key: 'total', dependsOn: ['price'] },
      { key: 'unrelatedFormula', dependsOn: ['someOtherField'] },
    ];

    const result = getAffectedFormulaKeysInOrder(formulaFields, ['price']);

    expect(result).toContain('total');
    expect(result).not.toContain('unrelatedFormula');
  });

  it('includes independent formula fields each triggered by a different changed key, order between them unconstrained', () => {
    const formulaFields = [
      { key: 'totalA', dependsOn: ['priceA'] },
      { key: 'totalB', dependsOn: ['priceB'] },
    ];

    const result = getAffectedFormulaKeysInOrder(formulaFields, ['priceA', 'priceB']);

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(['totalA', 'totalB']));
  });

  it('does not hang or throw when fed a cyclic formula field graph (defensive safety, no correctness claim)', () => {
    const formulaFields = [
      { key: 'a', dependsOn: ['b'] },
      { key: 'b', dependsOn: ['a'] },
    ];

    expect(() => getAffectedFormulaKeysInOrder(formulaFields, ['a'])).not.toThrow();

    const result = getAffectedFormulaKeysInOrder(formulaFields, ['a']);
    expect(Array.isArray(result)).toBe(true);
  });

  describe('performance: recompute ordering on a ~1000-node linear chain stays under 100ms', () => {
    function buildChain(length: number): { key: string; dependsOn: string[] }[] {
      const chain: { key: string; dependsOn: string[] }[] = [];

      for (let i = 0; i < length; i += 1) {
        const dependsOn = i === 0 ? ['baseField'] : [`field${String(i - 1)}`];
        chain.push({ key: `field${String(i)}`, dependsOn });
      }

      return chain;
    }

    it('returns the full ~1000-entry chain in correct dependency order within 100ms', () => {
      const chain = buildChain(999);

      const start = performance.now();
      const result = getAffectedFormulaKeysInOrder(chain, ['baseField']);
      const elapsedMs = performance.now() - start;

      expect(result).toHaveLength(999);

      for (let i = 1; i < 999; i += 1) {
        expect(result.indexOf(`field${String(i - 1)}`)).toBeLessThan(
          result.indexOf(`field${String(i)}`),
        );
      }

      expect(elapsedMs).toBeLessThan(100);
    });
  });
});
