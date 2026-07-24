import { describe, expect, it } from 'vitest';

import { findDependencyCycle, findParentCycle } from './relation-graph.js';

import type { Relation, RelationKind } from './relation.js';

/**
 * Designed signatures (must be matched exactly by implementer):
 *
 *   findParentCycle(
 *     existingParentChild: Relation[],
 *     proposedParentId: string,
 *     proposedChildId: string,
 *   ): string[] | null
 *     -> null when adding a parentChild edge proposedParentId -> proposedChildId
 *        would NOT create a cycle.
 *     -> a non-empty string[] cycle chain (order unspecified beyond containing
 *        the involved ids) when it WOULD create a cycle — including the
 *        degenerate self case proposedParentId === proposedChildId.
 *     -> only entries in `existingParentChild` with status: 'active'
 *        participate; 'removed' entries must be ignored entirely.
 *
 *   findDependencyCycle(
 *     existingDependencies: Relation[],
 *     proposedFromId: string,
 *     proposedToId: string,
 *   ): string[] | null
 *     -> same contract as findParentCycle, for dependency edges
 *        (proposedFromId blocks proposedToId).
 *
 * Both are pure, synchronous, framework-free graph traversals used
 * internally by relation-commands.ts, and must stay fast on graphs up to
 * ~1000 nodes (spec AC: "1000 nesnelik zincirde döngü tespiti < 50ms").
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

let relationCounter = 0;

function buildRelation(
  fromId: string,
  toId: string,
  kind: RelationKind,
  status: Relation['status'] = 'active',
): Relation {
  relationCounter += 1;
  return {
    id: `graph-relation-${String(relationCounter)}`,
    workspaceId: WORKSPACE_ID,
    fromId,
    toId,
    kind,
    status,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('findParentCycle', () => {
  it('returns null when there are no existing relations and the edge is not a self-loop', () => {
    expect(findParentCycle([], 'obj-parent', 'obj-child')).toBeNull();
  });

  it('returns a non-null cycle chain for a self edge, even with zero existing relations', () => {
    const result = findParentCycle([], 'obj-x', 'obj-x');

    expect(result).not.toBeNull();
    expect(result).toContain('obj-x');
  });

  it('detects a cycle when proposing a grandchild as the parent of its own grandparent', () => {
    // X is parent of A, A is parent of Y (X -> A -> Y).
    const existing = [
      buildRelation('obj-x', 'obj-a', 'parentChild'),
      buildRelation('obj-a', 'obj-y', 'parentChild'),
    ];

    const result = findParentCycle(existing, 'obj-y', 'obj-x');

    expect(result).not.toBeNull();
    expect(result).toContain('obj-x');
    expect(result).toContain('obj-y');
  });

  it('returns null for a parent proposal from an unrelated node, even though the child already has ancestors', () => {
    const existing = [
      buildRelation('obj-x', 'obj-a', 'parentChild'),
      buildRelation('obj-a', 'obj-y', 'parentChild'),
    ];

    expect(findParentCycle(existing, 'obj-z', 'obj-x')).toBeNull();
  });

  it('ignores relations with status "removed" when detecting cycles', () => {
    const existing = [
      buildRelation('obj-x', 'obj-a', 'parentChild', 'removed'),
      buildRelation('obj-a', 'obj-y', 'parentChild', 'active'),
    ];

    // If the removed obj-x -> obj-a edge were still considered active, this
    // proposal would close a cycle. It must not, since it's removed.
    expect(findParentCycle(existing, 'obj-y', 'obj-x')).toBeNull();
  });
});

describe('findDependencyCycle', () => {
  it('returns null when there are no existing edges and the edge is not a self-loop', () => {
    expect(findDependencyCycle([], 'obj-a', 'obj-b')).toBeNull();
  });

  it('returns a non-null cycle chain for a direct self-loop', () => {
    const result = findDependencyCycle([], 'obj-a', 'obj-a');

    expect(result).not.toBeNull();
    expect(result).toContain('obj-a');
  });

  it('detects a cycle when closing an A->B->C->A loop', () => {
    const existing = [
      buildRelation('obj-a', 'obj-b', 'dependency'),
      buildRelation('obj-b', 'obj-c', 'dependency'),
    ];

    const result = findDependencyCycle(existing, 'obj-c', 'obj-a');

    expect(result).not.toBeNull();
    expect(result).toContain('obj-a');
    expect(result).toContain('obj-b');
    expect(result).toContain('obj-c');
  });

  it('returns null when proposing an edge to an unrelated node with no path back', () => {
    const existing = [
      buildRelation('obj-a', 'obj-b', 'dependency'),
      buildRelation('obj-b', 'obj-c', 'dependency'),
    ];

    expect(findDependencyCycle(existing, 'obj-a', 'obj-d')).toBeNull();
  });

  it('ignores relations with status "removed" when detecting cycles', () => {
    const existing = [
      buildRelation('obj-a', 'obj-b', 'dependency', 'removed'),
      buildRelation('obj-b', 'obj-c', 'dependency', 'active'),
    ];

    expect(findDependencyCycle(existing, 'obj-c', 'obj-a')).toBeNull();
  });
});

describe('performance: cycle detection on a 1000-node chain stays under 50ms', () => {
  it('findParentCycle detects a cycle closure at the far end of a 1000-node chain within 50ms', () => {
    const chain: Relation[] = [];
    for (let i = 0; i < 999; i += 1) {
      chain.push(buildRelation(`node${String(i)}`, `node${String(i + 1)}`, 'parentChild'));
    }

    const start = performance.now();
    const result = findParentCycle(chain, 'node999', 'node0');
    const elapsedMs = performance.now() - start;

    expect(result).not.toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });

  it('findParentCycle returns null for a non-cyclic proposal against a 1000-node chain within 50ms', () => {
    const chain: Relation[] = [];
    for (let i = 0; i < 999; i += 1) {
      chain.push(buildRelation(`node${String(i)}`, `node${String(i + 1)}`, 'parentChild'));
    }

    const start = performance.now();
    const result = findParentCycle(chain, 'fresh-parent', 'fresh-child');
    const elapsedMs = performance.now() - start;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });

  it('findDependencyCycle detects a cycle closure at the far end of a 1000-node chain within 50ms', () => {
    const chain: Relation[] = [];
    for (let i = 0; i < 999; i += 1) {
      chain.push(buildRelation(`node${String(i)}`, `node${String(i + 1)}`, 'dependency'));
    }

    const start = performance.now();
    const result = findDependencyCycle(chain, 'node999', 'node0');
    const elapsedMs = performance.now() - start;

    expect(result).not.toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });

  it('findDependencyCycle returns null for a non-cyclic proposal against a 1000-node chain within 50ms', () => {
    const chain: Relation[] = [];
    for (let i = 0; i < 999; i += 1) {
      chain.push(buildRelation(`node${String(i)}`, `node${String(i + 1)}`, 'dependency'));
    }

    const start = performance.now();
    const result = findDependencyCycle(chain, 'fresh-a', 'fresh-b');
    const elapsedMs = performance.now() - start;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });
});
