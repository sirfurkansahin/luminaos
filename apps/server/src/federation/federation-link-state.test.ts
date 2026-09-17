import { beforeAll, describe, expect, it } from 'vitest';

/**
 * F3-T14 PR1 (RED step), ADR-0048 §b — pure, DB-less unit tests for
 * `./federation-link-state.ts` (does NOT exist yet as of this commit):
 * `canTransition(from, to): boolean` and `computePairKey(a, b): string`.
 *
 * ============================================================================
 * HARNESS CHOICE: same reasoning as `../mcp-server/mcp-client-grants.service.test.ts`'s
 * header -- since `./federation-link-state.ts` does not exist yet, a STATIC
 * top-level `import` of it would fail module resolution for the whole file at
 * collection time with an unresolvable `import-x/no-unresolved` lint error
 * (and cascading `no-unsafe-*` errors from every call site whose types can't
 * be inferred). Instead, `FederationLinkStatus` is declared LOCALLY and both
 * functions are loaded via a single dynamic `import()` in `beforeAll`,
 * degrading to one isolated, EXPECTED `import-x/no-unresolved` finding at
 * that one line.
 *
 * EXPECTED RED STATE (today): `beforeAll`'s dynamic `import('./federation-link-state.js')`
 * rejects with a "Cannot find module" resolution error, failing every test in
 * this file at setup -- this is the correct red (implementation missing), not
 * a test-logic bug.
 * ============================================================================
 *
 * `canTransition` is asserted over the FULL 3x3 status matrix (`pending`,
 * `active`, `revoked`) rather than only the "valid" transitions, so that any
 * future accidental widening of the state machine (e.g. someone later adding
 * `active -> pending`) is caught by an EXISTING test flipping from pass to
 * fail, not silently passing because that combination was never asserted.
 */

type FederationLinkStatus = 'pending' | 'active' | 'revoked';

interface FederationLinkStateModule {
  canTransition: (from: FederationLinkStatus, to: FederationLinkStatus) => boolean;
  computePairKey: (workspaceIdA: string, workspaceIdB: string) => string;
}

const ALL_STATUSES: FederationLinkStatus[] = ['pending', 'active', 'revoked'];

/** ADR-0048 §b's exact, exhaustive decision table: only `pending->active` and
 * `{pending,active}->revoked` are valid; every other one of the 9 (from, to)
 * combinations -- including same-state no-ops and the reverse of every valid
 * edge -- must be `false`. */
const EXPECTED_TRANSITIONS: Record<FederationLinkStatus, Record<FederationLinkStatus, boolean>> = {
  pending: { pending: false, active: true, revoked: true },
  active: { pending: false, active: false, revoked: true },
  revoked: { pending: false, active: false, revoked: false },
};

describe('federation-link-state (ADR-0048 §b: canTransition / computePairKey, pure DB-less)', () => {
  let canTransition: FederationLinkStateModule['canTransition'];
  let computePairKey: FederationLinkStateModule['computePairKey'];

  beforeAll(async () => {
    // Deliberately unresolvable until `implementer` creates
    // `./federation-link-state.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained to
    // this one line.
    const importedModule: unknown = await import('./federation-link-state.js');
    const mod = importedModule as FederationLinkStateModule;
    canTransition = mod.canTransition;
    computePairKey = mod.computePairKey;
  });

  describe('canTransition', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = EXPECTED_TRANSITIONS[from][to];
        it(`${from} -> ${to} is ${String(expected)}`, () => {
          expect(canTransition(from, to)).toBe(expected);
        });
      }
    }

    it('revoked is a true terminal state -- no transition out of it is ever valid, for any target', () => {
      for (const to of ALL_STATUSES) {
        expect(canTransition('revoked', to)).toBe(false);
      }
    });

    it('the only two valid FROM-states are pending and active -- exactly 3 true cells in the whole 3x3 matrix', () => {
      const trueCells = ALL_STATUSES.flatMap((from) =>
        ALL_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
      );
      expect(trueCells.sort()).toEqual(['active->revoked', 'pending->active', 'pending->revoked']);
    });
  });

  describe('computePairKey', () => {
    it('is direction-independent -- computePairKey(A, B) === computePairKey(B, A)', () => {
      const a = '11111111-1111-1111-1111-111111111111';
      const b = '22222222-2222-2222-2222-222222222222';
      expect(computePairKey(a, b)).toBe(computePairKey(b, a));
    });

    it('produces the exact "min:max" sorted-join shape the ADR pins', () => {
      const a = '22222222-2222-2222-2222-222222222222';
      const b = '11111111-1111-1111-1111-111111111111';
      expect(computePairKey(a, b)).toBe(`${b}:${a}`);
    });

    it('two different pairs sharing one workspace id produce two different pair keys', () => {
      const shared = '11111111-1111-1111-1111-111111111111';
      const other1 = '22222222-2222-2222-2222-222222222222';
      const other2 = '33333333-3333-3333-3333-333333333333';
      expect(computePairKey(shared, other1)).not.toBe(computePairKey(shared, other2));
    });

    it('is stable/idempotent for the same unordered pair called repeatedly', () => {
      const a = '11111111-1111-1111-1111-111111111111';
      const b = '22222222-2222-2222-2222-222222222222';
      const first = computePairKey(a, b);
      const second = computePairKey(b, a);
      const third = computePairKey(a, b);
      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });
});
