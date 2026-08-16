import { describe, expect, it } from 'vitest';

import { computeRelevanceScore, sortEdgesByRelevance } from './relevance-scoring.js';

/**
 * F2-T4 (RED step, pure-function half). Pins `apps/server/src/context/
 * relevance-scoring.ts` (does not exist yet), per ADR-0021:
 *
 *  - Karar (b): exponential damping, 14-day half-life --
 *    `factor = 0.5 ** (ageInDays / 14)`, `ageInDays = (now - createdAt) /
 *    86_400_000`.
 *  - Karar (c): edge-type base weights -- `entity-time: 1.0`, `entity-topic:
 *    0.8`, `person-topic: 0.6`, `person-time: 0.4`.
 *  - Karar (d): `entity-entity`/`entity-person` are OUT of scoring
 *    (`computeRelevanceScore` returns `null` for them); `sortEdgesByRelevance`
 *    appends them at the END, preserving their own original relative order.
 *  - Karar (g): pure, deterministic, `now`-injected functions -- no
 *    `Date.now()` dependency, no I/O, no mutation of the input array.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./relevance-scoring.js` does not exist, so
 * every `it` below fails at the top-level `import` (module resolution
 * error), not because of an assertion failure.
 * ============================================================================
 */

const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;

function daysAfter(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}

describe('F2-T4 (RED step): relevance-scoring.ts pure functions (ADR-0021)', () => {
  describe('computeRelevanceScore', () => {
    it('1. ageInDays=0 (now === createdAt) yields exactly the base weight for entity-time (factor=1.0 -> 1.0)', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');

      expect(computeRelevanceScore('entity-time', now, now)).toBe(1.0);
    });

    it('2. 14 days later (one half-life) yields ~0.5 for entity-time', () => {
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      const now = daysAfter(createdAt, HALF_LIFE_DAYS);

      expect(computeRelevanceScore('entity-time', createdAt, now)).toBeCloseTo(0.5, 5);
    });

    it('3. 28 days later (two half-lives) yields ~0.25 for entity-time', () => {
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      const now = daysAfter(createdAt, 2 * HALF_LIFE_DAYS);

      expect(computeRelevanceScore('entity-time', createdAt, now)).toBeCloseTo(0.25, 5);
    });

    it('4. at ageInDays=0, each of the 4 scored edge types matches its exact ADR-0021 Karar (c) base weight', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');

      expect(computeRelevanceScore('entity-time', now, now)).toBe(1.0);
      expect(computeRelevanceScore('entity-topic', now, now)).toBe(0.8);
      expect(computeRelevanceScore('person-topic', now, now)).toBe(0.6);
      expect(computeRelevanceScore('person-time', now, now)).toBe(0.4);
    });

    it('5. entity-entity and entity-person are unscored -- both return null regardless of age', () => {
      const createdAt = new Date('2026-07-01T00:00:00.000Z');
      const now = new Date('2026-08-16T00:00:00.000Z');

      expect(computeRelevanceScore('entity-entity', createdAt, now)).toBeNull();
      expect(computeRelevanceScore('entity-person', createdAt, now)).toBeNull();
      // Also true at ageInDays=0, proving it's the edge TYPE that excludes
      // these, not some age-based side effect.
      expect(computeRelevanceScore('entity-entity', now, now)).toBeNull();
      expect(computeRelevanceScore('entity-person', now, now)).toBeNull();
    });

    it('6. is a pure function -- calling it twice with identical inputs produces an identical result', () => {
      const createdAt = new Date('2026-08-01T09:30:00.000Z');
      const now = new Date('2026-08-10T14:45:00.000Z');

      const first = computeRelevanceScore('entity-topic', createdAt, now);
      const second = computeRelevanceScore('entity-topic', createdAt, now);

      expect(first).toBe(second);
      expect(first).not.toBeNull();
    });
  });

  describe('sortEdgesByRelevance', () => {
    interface Edge {
      id: string;
      edgeType: string;
      createdAt: Date;
    }

    it('7. sorts scorable edges by descending relevance score, THEN appends unscorable edges at the end preserving their own original relative order', () => {
      const now = new Date('2026-08-16T00:00:00.000Z');

      // Deliberately interleaved: scorable and unscorable edges are NOT
      // grouped together in the input, so a naive "stable sort on score"
      // (which would treat `null` as some default) could accidentally pass
      // by coincidence -- this input specifically guards against that.
      const edges: Edge[] = [
        { id: 'fresh-entity-time', edgeType: 'entity-time', createdAt: now }, // score 1.0
        { id: 'fresh-entity-topic', edgeType: 'entity-topic', createdAt: now }, // score 0.8
        { id: 'structural-1-entity-entity', edgeType: 'entity-entity', createdAt: now },
        {
          id: 'half-life-entity-time',
          edgeType: 'entity-time',
          createdAt: daysAfter(now, -HALF_LIFE_DAYS),
        }, // score 0.5
        { id: 'structural-2-entity-person', edgeType: 'entity-person', createdAt: now },
        {
          id: 'two-half-lives-entity-topic',
          edgeType: 'entity-topic',
          createdAt: daysAfter(now, -2 * HALF_LIFE_DAYS),
        }, // score 0.2
      ];

      const sorted = sortEdgesByRelevance(edges, now);

      // Scorable edges, in strictly descending score order.
      expect(sorted.slice(0, 4).map((edge) => edge.id)).toEqual([
        'fresh-entity-time',
        'fresh-entity-topic',
        'half-life-entity-time',
        'two-half-lives-entity-topic',
      ]);

      // Unscorable edges appended at the end, own original relative order
      // preserved (structural-1 appeared before structural-2 in the input).
      expect(sorted.slice(4).map((edge) => edge.id)).toEqual([
        'structural-1-entity-entity',
        'structural-2-entity-person',
      ]);
    });

    it('8. does not mutate the input array -- returns a new array, leaves the original order/reference contents untouched', () => {
      const now = new Date('2026-08-16T00:00:00.000Z');
      const edges: Edge[] = [
        { id: 'a', edgeType: 'entity-entity', createdAt: now },
        { id: 'b', edgeType: 'entity-time', createdAt: now },
        { id: 'c', edgeType: 'entity-topic', createdAt: daysAfter(now, -HALF_LIFE_DAYS) },
      ];
      const originalOrderIds = edges.map((edge) => edge.id);

      const result = sortEdgesByRelevance(edges, now);

      expect(edges.map((edge) => edge.id)).toEqual(originalOrderIds);
      expect(result).not.toBe(edges);
    });
  });
});
