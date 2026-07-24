/**
 * Per F1-T4 plan: pure, synchronous, framework-free cycle detection for
 * formula-to-formula dependencies, mirroring
 * `../../relations/relation-graph.ts`'s `findDependencyCycle` style. Must
 * stay fast on graphs up to ~1000 nodes (same "1000 nesnelik zincirde döngü
 * tespiti < 50ms" AC, applied here to formula fields).
 */

interface FormulaFieldNode {
  key: string;
  dependsOn: readonly string[];
}

/**
 * Detects whether adding/updating a formula field `candidateKey` whose
 * expression depends on `candidateDependsOn` would create a
 * formula-to-formula dependency cycle among `existingFormulaFields`. Returns
 * the cycle chain (a non-empty array of the involved keys) when it would,
 * otherwise `null`.
 *
 * Update-in-place: if `candidateKey` already appears as a `key` in
 * `existingFormulaFields` (the field is being updated, not newly defined),
 * that entry's OLD `dependsOn` is excluded from the adjacency map entirely —
 * only `candidateDependsOn` represents that key going forward.
 */
export function findFormulaCycle(
  existingFormulaFields: readonly FormulaFieldNode[],
  candidateKey: string,
  candidateDependsOn: readonly string[],
): string[] | null {
  if (candidateDependsOn.includes(candidateKey)) {
    return [candidateKey, candidateKey];
  }

  // key -> the keys it depends on (forward "depends on" edges), excluding
  // the candidate's own stale entry (the update-in-place case).
  const adjacency = new Map<string, string[]>();

  for (const field of existingFormulaFields) {
    if (field.key === candidateKey) {
      continue;
    }

    const targets = adjacency.get(field.key);
    if (targets) {
      targets.push(...field.dependsOn);
    } else {
      adjacency.set(field.key, [...field.dependsOn]);
    }
  }

  // BFS forward from each of the candidate's direct dependencies, looking
  // for a path that leads back to `candidateKey` -- which, combined with the
  // proposed `candidateKey -> candidateDependsOn` edges, would close a cycle.
  const visited = new Set<string>(candidateDependsOn);
  const queue: string[] = [...candidateDependsOn];
  const cameFrom = new Map<string, string>();

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }

    const neighbors = adjacency.get(node) ?? [];

    for (const neighbor of neighbors) {
      if (neighbor === candidateKey) {
        // Reconstruct the path from a direct dependency of candidateKey
        // through to `node`, then close the loop with candidateKey at both
        // ends.
        const path: string[] = [node];
        let step: string | undefined = node;

        while (cameFrom.has(step)) {
          const previous = cameFrom.get(step);
          if (previous === undefined) {
            break;
          }
          path.unshift(previous);
          step = previous;
        }

        return [candidateKey, ...path, candidateKey];
      }

      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        cameFrom.set(neighbor, node);
        queue.push(neighbor);
      }
    }
  }

  return null;
}
