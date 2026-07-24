import type { Relation } from './relation.js';

/**
 * Per F1-T3 plan: pure, synchronous, framework-free graph traversals used
 * internally by `relation-commands.ts` to detect cycles before an edge is
 * accepted. Both must stay fast on graphs up to ~1000 nodes (spec AC:
 * "1000 nesnelik zincirde döngü tespiti < 50ms").
 */

/**
 * Detects whether proposing a `proposedParentId -> proposedChildId`
 * parentChild edge would create a cycle among the ACTIVE parentChild
 * relations in `existingParentChild`. Returns the cycle chain (a non-empty
 * array of the involved ids) when it would, otherwise `null`.
 */
export function findParentCycle(
  existingParentChild: Relation[],
  proposedParentId: string,
  proposedChildId: string,
): string[] | null {
  if (proposedParentId === proposedChildId) {
    return [proposedChildId, proposedParentId];
  }

  // child -> parent map (each child has at most one active parent).
  const parentOf = new Map<string, string>();

  for (const relation of existingParentChild) {
    if (relation.status !== 'active') {
      continue;
    }
    parentOf.set(relation.toId, relation.fromId);
  }

  const chain: string[] = [proposedParentId];
  let current: string | undefined = proposedParentId;
  const maxIterations = existingParentChild.length + 1;

  for (let i = 0; i < maxIterations; i += 1) {
    if (current === proposedChildId) {
      return chain;
    }

    const next = parentOf.get(current);

    if (next === undefined) {
      return null;
    }

    current = next;
    chain.push(current);
  }

  return null;
}

/**
 * Detects whether proposing a `proposedFromId -> proposedToId` dependency
 * edge would create a cycle among the ACTIVE dependency relations in
 * `existingDependencies`. Returns the cycle chain (a non-empty array of the
 * involved ids) when it would, otherwise `null`.
 */
export function findDependencyCycle(
  existingDependencies: Relation[],
  proposedFromId: string,
  proposedToId: string,
): string[] | null {
  if (proposedFromId === proposedToId) {
    return [proposedFromId, proposedToId];
  }

  const adjacency = new Map<string, string[]>();

  for (const relation of existingDependencies) {
    if (relation.status !== 'active') {
      continue;
    }
    const targets = adjacency.get(relation.fromId);
    if (targets) {
      targets.push(relation.toId);
    } else {
      adjacency.set(relation.fromId, [relation.toId]);
    }
  }

  // A path from proposedToId back to proposedFromId, combined with the
  // proposed proposedFromId -> proposedToId edge, would close a cycle.
  const visited = new Set<string>([proposedToId]);
  const queue: string[] = [proposedToId];
  const cameFrom = new Map<string, string>();

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }

    if (node === proposedFromId) {
      // Reconstruct the path proposedToId -> ... -> proposedFromId, then
      // prepend proposedFromId to represent the proposed closing edge.
      const path: string[] = [];
      let step: string | undefined = node;
      while (step !== undefined) {
        path.unshift(step);
        step = cameFrom.get(step);
      }
      return [proposedFromId, ...path];
    }

    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        cameFrom.set(neighbor, node);
        queue.push(neighbor);
      }
    }
  }

  return null;
}
