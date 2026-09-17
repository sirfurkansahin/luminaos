import { beforeAll, describe, expect, it } from 'vitest';

import type { ContextResponse, ContextEdgeSummary } from '../context/context.service.js';

/**
 * F3-T14 PR2 (RED step), ADR-0048 §"filterFederatedContextGraph" (the ADR's
 * own "YENİ, mimari-inceleme kaynaklı bulgusu" section, between §f and §h) --
 * pure, DB-less unit tests for `./filter-federated-context-graph.ts` (does
 * NOT exist yet as of this commit).
 *
 * ============================================================================
 * HARNESS CHOICE: same reasoning as `./federation-link-state.test.ts`'s
 * header -- since `./filter-federated-context-graph.ts` does not exist yet, a
 * STATIC top-level `import` of the function itself would fail module
 * resolution for the whole file at collection time. `filterFederatedContextGraph`
 * is loaded via a single dynamic `import()` in `beforeAll` instead, degrading
 * to one isolated, EXPECTED `import-x/no-unresolved` finding at that one
 * line. `ContextResponse`/`ContextEdgeSummary` ARE imported statically as
 * TYPES ONLY (`import type`) -- `../context/context.service.ts` already
 * exists (predates F3-T14), so this carries no resolution risk and lets this
 * file build its fixtures with full type-checking against the real, pinned
 * `ContextResponse` shape (ADR-0018 §b/§c/§d) rather than a hand-duplicated
 * local interface.
 *
 * EXPECTED RED STATE (today): `beforeAll`'s dynamic
 * `import('./filter-federated-context-graph.js')` rejects with a "Cannot
 * find module" resolution error, failing every test in this file at setup --
 * this is the correct red (implementation missing), not a test-logic bug.
 * ============================================================================
 */

interface FilterFederatedContextGraphModule {
  filterFederatedContextGraph: (
    response: ContextResponse,
    allowedObjectIds: ReadonlySet<string>,
  ) => ContextResponse;
}

function buildEntityEdge(
  entityId: string,
  overrides: Partial<ContextEdgeSummary> = {},
): ContextEdgeSummary {
  return {
    edgeType: 'related_to',
    direction: 'outgoing',
    sourceFieldKey: null,
    sourceRelationId: `relation-${entityId}`,
    node: {
      nodeType: 'entity',
      naturalKey: `natural-key-${entityId}`,
      entityId,
      objectType: 'task',
      title: `Entity ${entityId}`,
    },
    ...overrides,
  };
}

function buildNonEntityEdge(
  nodeType: 'person' | 'time' | 'topic',
  naturalKey: string,
): ContextEdgeSummary {
  return {
    edgeType:
      nodeType === 'person' ? 'mentions' : nodeType === 'time' ? 'scheduled_at' : 'tagged_with',
    direction: 'outgoing',
    sourceFieldKey: null,
    sourceRelationId: null,
    node: {
      nodeType,
      naturalKey,
      // Deliberately no `entityId`/`objectType`/`title` -- non-entity nodes
      // (person/time/topic) don't carry them (ADR-0018 §b), and this
      // function must never require them to decide NOT to filter.
    },
  };
}

function buildResponse(edges: ContextEdgeSummary[]): ContextResponse {
  return {
    asOf: '2026-09-17T00:00:00.000Z',
    entity: {
      entityId: 'root-entity',
      objectType: 'task',
      title: 'Root Object',
      fieldValues: { note: 'root fields are never touched by this function' },
    },
    edges,
  };
}

describe('filterFederatedContextGraph (ADR-0048, komşu-nesne sızıntısı önlemi -- pure, DB-less)', () => {
  let filterFederatedContextGraph: FilterFederatedContextGraphModule['filterFederatedContextGraph'];

  beforeAll(async () => {
    // Deliberately unresolvable until `implementer` creates
    // `./filter-federated-context-graph.ts` -- see this file's header for why
    // the resulting `import-x/no-unresolved` finding is expected and
    // contained to this one line.
    const importedModule: unknown = await import('./filter-federated-context-graph.js');
    filterFederatedContextGraph = (importedModule as FilterFederatedContextGraphModule)
      .filterFederatedContextGraph;
  });

  it('an `entity`-type neighbor NOT in allowedObjectIds is REMOVED ENTIRELY -- the edge itself disappears, not just its title/fieldValues', () => {
    const allowedIds = new Set<string>(['in-scope-entity']);
    const outOfScopeEdge = buildEntityEdge('out-of-scope-entity');
    const response = buildResponse([outOfScopeEdge]);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges).toHaveLength(0);
    expect(JSON.stringify(filtered)).not.toContain('out-of-scope-entity');
    expect(JSON.stringify(filtered)).not.toContain('Entity out-of-scope-entity');
  });

  it('an `entity`-type neighbor that IS in allowedObjectIds passes through completely UNCHANGED', () => {
    const allowedIds = new Set<string>(['in-scope-entity']);
    const inScopeEdge = buildEntityEdge('in-scope-entity');
    const response = buildResponse([inScopeEdge]);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges).toHaveLength(1);
    expect(filtered.edges[0]).toEqual(inScopeEdge);
  });

  it('a mix of in-scope and out-of-scope `entity` neighbors -- only the out-of-scope one is dropped, order/content of the rest preserved', () => {
    const allowedIds = new Set<string>(['keep-1', 'keep-2']);
    const edges = [
      buildEntityEdge('keep-1'),
      buildEntityEdge('drop-me'),
      buildEntityEdge('keep-2'),
    ];
    const response = buildResponse(edges);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges.map((edge) => edge.node.entityId)).toEqual(['keep-1', 'keep-2']);
  });

  it('`person` neighbor nodes are NEVER filtered, even when their naturalKey is nowhere in allowedObjectIds (İnsan kararı 2: already-granted own-field data)', () => {
    const allowedIds = new Set<string>(); // deliberately empty
    const personEdge = buildNonEntityEdge('person', 'person-natural-key-1');
    const response = buildResponse([personEdge]);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges).toHaveLength(1);
    expect(filtered.edges[0]).toEqual(personEdge);
  });

  it('`time` neighbor nodes are NEVER filtered, even when allowedObjectIds is empty', () => {
    const allowedIds = new Set<string>();
    const timeEdge = buildNonEntityEdge('time', 'time-natural-key-1');
    const response = buildResponse([timeEdge]);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges).toHaveLength(1);
    expect(filtered.edges[0]).toEqual(timeEdge);
  });

  it('`topic` neighbor nodes are NEVER filtered, even when allowedObjectIds is empty', () => {
    const allowedIds = new Set<string>();
    const topicEdge = buildNonEntityEdge('topic', 'topic-natural-key-1');
    const response = buildResponse([topicEdge]);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges).toHaveLength(1);
    expect(filtered.edges[0]).toEqual(topicEdge);
  });

  it('a combined graph: out-of-scope entity dropped, in-scope entity kept, person/time/topic all kept regardless of scope -- the full sızıntı-önlemi contract in one shot', () => {
    const allowedIds = new Set<string>(['kept-entity']);
    const edges = [
      buildEntityEdge('kept-entity'),
      buildEntityEdge('leaked-entity'),
      buildNonEntityEdge('person', 'p-1'),
      buildNonEntityEdge('time', 't-1'),
      buildNonEntityEdge('topic', 'topic-1'),
    ];
    const response = buildResponse(edges);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.edges).toHaveLength(4);
    expect(filtered.edges.some((edge) => edge.node.entityId === 'leaked-entity')).toBe(false);
    expect(filtered.edges.some((edge) => edge.node.entityId === 'kept-entity')).toBe(true);
    expect(filtered.edges.some((edge) => edge.node.nodeType === 'person')).toBe(true);
    expect(filtered.edges.some((edge) => edge.node.nodeType === 'time')).toBe(true);
    expect(filtered.edges.some((edge) => edge.node.nodeType === 'topic')).toBe(true);
  });

  it('the root `entity` (`response.entity`) is NEVER touched by this function -- only `edges` is filtered', () => {
    const allowedIds = new Set<string>(); // empty -- would drop every entity edge
    const response = buildResponse([buildEntityEdge('some-neighbor')]);

    const filtered = filterFederatedContextGraph(response, allowedIds);

    expect(filtered.entity).toEqual(response.entity);
    expect(filtered.asOf).toEqual(response.asOf);
  });

  it('an `entity` edge whose node is missing `entityId` (defensive/malformed input) is treated as NOT allowed and is dropped, never a crash', () => {
    const allowedIds = new Set<string>(['anything']);
    const malformedEdge = buildEntityEdge('irrelevant', {
      node: { nodeType: 'entity', naturalKey: 'malformed-natural-key' },
    });
    const response = buildResponse([malformedEdge]);

    expect(() => filterFederatedContextGraph(response, allowedIds)).not.toThrow();
    const filtered = filterFederatedContextGraph(response, allowedIds);
    expect(filtered.edges).toHaveLength(0);
  });

  it('empty edges array in, empty edges array out', () => {
    const response = buildResponse([]);
    const filtered = filterFederatedContextGraph(response, new Set<string>());
    expect(filtered.edges).toEqual([]);
  });
});
