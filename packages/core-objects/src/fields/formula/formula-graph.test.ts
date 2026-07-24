import { describe, expect, it } from 'vitest';

import { findFormulaCycle } from './formula-graph.js';

/**
 * F1-T4 PR-A2 (RED step) — formula-to-formula dependency cycle detection.
 *
 * Designed signature (must be matched exactly by implementer), mirroring
 * F1-T3's `relation-graph.ts` `findDependencyCycle` style:
 *
 *   findFormulaCycle(
 *     existingFormulaFields: readonly { key: string; dependsOn: readonly string[] }[],
 *     candidateKey: string,
 *     candidateDependsOn: readonly string[],
 *   ): string[] | null
 *
 *     -> null when adding/updating a formula field with key `candidateKey`
 *        whose expression depends on the keys in `candidateDependsOn` would
 *        NOT create a formula-to-formula dependency cycle among
 *        `existingFormulaFields`.
 *     -> a non-empty string[] cycle chain (order unspecified beyond
 *        containing the involved keys) when it WOULD create a cycle,
 *        including the degenerate direct self-reference case
 *        (`candidateDependsOn` containing `candidateKey` itself).
 *     -> update-in-place: if `candidateKey` already appears as a `key` in
 *        `existingFormulaFields` (the field is being updated, not newly
 *        defined), that entry's OLD `dependsOn` must be excluded/overridden
 *        by `candidateDependsOn` — it must never be consulted, so it can
 *        never cause a spurious cycle report.
 *     -> pure, synchronous, framework-free; must stay fast on ~1000-node
 *        chains (mirroring relation-graph's "1000 nesnelik zincirde döngü
 *        tespiti < 50ms" AC applied to formula fields).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/core-objects/src/fields/formula/formula-graph.ts`.
 */

describe('findFormulaCycle', () => {
  it('returns null when there are no existing formula fields and the candidate depends on nothing', () => {
    expect(findFormulaCycle([], 'total', [])).toBeNull();
  });

  it('returns a non-null cycle chain when the candidate references itself directly', () => {
    const result = findFormulaCycle([], 'total', ['total']);

    expect(result).not.toBeNull();
    expect(result).toContain('total');
  });

  it('detects a cycle closed by a chain: existing B depends on A, existing C depends on B, candidate A depends on C', () => {
    const existing = [
      { key: 'B', dependsOn: ['A'] },
      { key: 'C', dependsOn: ['B'] },
    ];

    const result = findFormulaCycle(existing, 'A', ['C']);

    expect(result).not.toBeNull();
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
  });

  it('returns null when the candidate depends on an unrelated existing formula field with no path back', () => {
    const existing = [
      { key: 'B', dependsOn: ['A'] },
      { key: 'C', dependsOn: ['B'] },
    ];

    // X is a brand-new key with no dependents anywhere in `existing` that
    // could lead back to X.
    expect(findFormulaCycle(existing, 'X', ['B'])).toBeNull();
  });

  it('returns null for a deep but acyclic chain (reachability alone does not imply a cycle)', () => {
    const existing = [
      { key: 'A', dependsOn: ['B'] },
      { key: 'B', dependsOn: ['C'] },
      { key: 'C', dependsOn: ['D'] },
      { key: 'D', dependsOn: ['E'] },
    ];

    // Z is unrelated to the whole A->B->C->D->E chain.
    expect(findFormulaCycle(existing, 'Z', ['A'])).toBeNull();
  });

  describe('update-in-place: the candidate key already exists in existingFormulaFields', () => {
    it('does not spuriously trigger on the stale old dependsOn entry (basic case from spec)', () => {
      const existing = [{ key: 'X', dependsOn: ['Y'] }];

      // X is being updated in place: its expression used to depend on Y,
      // now depends on Z instead. Only Z's chain should matter.
      expect(findFormulaCycle(existing, 'X', ['Z'])).toBeNull();
    });

    it('ignores the stale entry even when it forms a mutual reference that would otherwise look cyclic', () => {
      const existing = [
        { key: 'X', dependsOn: ['Y'] },
        { key: 'Y', dependsOn: ['X'] },
      ];

      // X is being updated: its NEW expression depends only on Z, which has
      // no entry at all in `existing` and no path back to X. The stale
      // X<->Y mutual reference must be excluded/overridden, not merged in
      // alongside the new dependsOn.
      expect(findFormulaCycle(existing, 'X', ['Z'])).toBeNull();
    });

    it('still detects a genuinely new cycle introduced by the update itself', () => {
      const existing = [
        { key: 'X', dependsOn: ['Y'] },
        { key: 'W', dependsOn: ['X'] },
      ];

      // X is being updated to depend on W. W depends on X -> cycle X->W->X.
      const result = findFormulaCycle(existing, 'X', ['W']);

      expect(result).not.toBeNull();
      expect(result).toContain('X');
      expect(result).toContain('W');
    });
  });

  describe('performance: cycle detection on a ~1000-node chain stays under 50ms', () => {
    function buildChain(length: number): { key: string; dependsOn: string[] }[] {
      const chain: { key: string; dependsOn: string[] }[] = [];

      for (let i = 0; i < length; i += 1) {
        chain.push({ key: `field${String(i)}`, dependsOn: [`field${String(i + 1)}`] });
      }

      return chain;
    }

    it('detects a cycle closure at the far end of a 999-entry chain within 50ms', () => {
      const chain = buildChain(999); // field0 -> field1 -> ... -> field999

      const start = performance.now();
      const result = findFormulaCycle(chain, 'field999', ['field0']);
      const elapsedMs = performance.now() - start;

      expect(result).not.toBeNull();
      expect(elapsedMs).toBeLessThan(50);
    });

    it('returns null for a non-cyclic proposal against a 999-entry chain within 50ms', () => {
      const chain = buildChain(999);

      const start = performance.now();
      const result = findFormulaCycle(chain, 'fresh-field', ['field0']);
      const elapsedMs = performance.now() - start;

      expect(result).toBeNull();
      expect(elapsedMs).toBeLessThan(50);
    });
  });
});
