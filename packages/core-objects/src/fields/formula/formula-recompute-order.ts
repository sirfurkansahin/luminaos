/**
 * Per F1-T4 plan: incremental recompute ordering. Given the full set of
 * formula fields (with their `dependsOn` edges) and the keys that just
 * changed, determines which formula fields are affected (transitively
 * reachable from a changed key) and returns them in a valid topological
 * order (each formula field appears after every OTHER AFFECTED formula
 * field it depends on).
 *
 * Pure, synchronous, framework-free. Defensive against cyclic input (cycle
 * prevention is `findFormulaCycle`'s job at definition time, not this
 * function's) -- a visited-set guards the reachability BFS so a cycle can
 * never cause an infinite loop here.
 */

export interface FormulaFieldDependency {
  key: string;
  dependsOn: readonly string[];
}

export function getAffectedFormulaKeysInOrder(
  formulaFields: readonly FormulaFieldDependency[],
  changedKeys: readonly string[],
): string[] {
  if (formulaFields.length === 0 || changedKeys.length === 0) {
    return [];
  }

  // Reverse-dependency map: key D -> formula field keys whose `dependsOn`
  // directly includes D (i.e., "what depends on D").
  const dependents = new Map<string, string[]>();

  for (const field of formulaFields) {
    for (const dependency of field.dependsOn) {
      const existing = dependents.get(dependency);
      if (existing) {
        existing.push(field.key);
      } else {
        dependents.set(dependency, [field.key]);
      }
    }
  }

  // BFS reachability from every changed key, through the reverse map, to
  // find the set of affected formula field keys.
  const affected = new Set<string>();
  const queue: string[] = [...changedKeys];
  const enqueued = new Set<string>(changedKeys);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }

    const nextKeys = dependents.get(current) ?? [];

    for (const nextKey of nextKeys) {
      if (!affected.has(nextKey)) {
        affected.add(nextKey);
      }

      if (!enqueued.has(nextKey)) {
        enqueued.add(nextKey);
        queue.push(nextKey);
      }
    }
  }

  if (affected.size === 0) {
    return [];
  }

  // Topological sort (Kahn's algorithm) restricted to the affected subset:
  // an affected key's in-degree only counts its `dependsOn` entries that are
  // ALSO affected -- unaffected dependencies are already stable/correct.
  const fieldByKey = new Map<string, FormulaFieldDependency>();
  for (const field of formulaFields) {
    fieldByKey.set(field.key, field);
  }

  const inDegree = new Map<string, number>();
  const forwardEdges = new Map<string, string[]>();

  for (const key of affected) {
    inDegree.set(key, 0);
  }

  for (const key of affected) {
    const field = fieldByKey.get(key);
    if (!field) {
      continue;
    }

    for (const dependency of field.dependsOn) {
      if (!affected.has(dependency)) {
        continue;
      }

      inDegree.set(key, (inDegree.get(key) ?? 0) + 1);

      const existing = forwardEdges.get(dependency);
      if (existing) {
        existing.push(key);
      } else {
        forwardEdges.set(dependency, [key]);
      }
    }
  }

  const sortQueue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) {
      sortQueue.push(key);
    }
  }

  const result: string[] = [];
  const processed = new Set<string>();

  while (sortQueue.length > 0) {
    const node = sortQueue.shift();
    if (node === undefined) {
      break;
    }

    if (processed.has(node)) {
      continue;
    }
    processed.add(node);
    result.push(node);

    const next = forwardEdges.get(node) ?? [];
    for (const nextKey of next) {
      const remaining = (inDegree.get(nextKey) ?? 0) - 1;
      inDegree.set(nextKey, remaining);
      if (remaining === 0) {
        sortQueue.push(nextKey);
      }
    }
  }

  // Defensive: if a cycle exists entirely within the affected subset, Kahn's
  // algorithm will leave some nodes unprocessed (in-degree never reaches 0).
  // Append them so the function still returns every affected key exactly
  // once and never hangs, with no correctness claim about their order.
  if (result.length < affected.size) {
    for (const key of affected) {
      if (!processed.has(key)) {
        result.push(key);
      }
    }
  }

  return result;
}
