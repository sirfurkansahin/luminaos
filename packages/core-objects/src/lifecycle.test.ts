import { describe, expect, it } from 'vitest';

import { canTransition } from './lifecycle.js';

import type { Lifecycle } from './lumina-object.js';

/**
 * Designed API (per ADR-0003 "Yaşam döngüsü durum makinesi"):
 * `canTransition(from: Lifecycle, action: 'archive' | 'restore' |
 * 'softDelete'): boolean`. The target state is NOT a separate parameter —
 * it is fully implied by `action` (archive always targets `archived`,
 * restore always targets `active`, softDelete always targets `deleted`), so
 * a third `to` parameter would be redundant and could let a caller ask an
 * incoherent question (e.g. "can I archive into deleted?"). This is a pure
 * predicate with no side effects and no knowledge of a specific object.
 *
 * Legal transitions:
 *  - archive:    active -> archived                       (only)
 *  - restore:    archived -> active  OR  deleted -> active (only)
 *  - softDelete: active -> deleted   OR  archived -> deleted (only)
 *
 * Every other (from, action) pair must be false — enumerated explicitly
 * below rather than only positively asserted, per the acceptance criterion.
 */
describe('canTransition', () => {
  const allLifecycles: Lifecycle[] = ['active', 'archived', 'deleted'];
  const allActions = ['archive', 'restore', 'softDelete'] as const;

  const legalMatrix: Record<Lifecycle, Record<(typeof allActions)[number], boolean>> = {
    active: { archive: true, restore: false, softDelete: true },
    archived: { archive: false, restore: true, softDelete: true },
    deleted: { archive: false, restore: true, softDelete: false },
  };

  describe('archive', () => {
    it('allows active -> archived', () => {
      expect(canTransition('active', 'archive')).toBe(true);
    });

    it('rejects archiving an already-archived object', () => {
      expect(canTransition('archived', 'archive')).toBe(false);
    });

    it('rejects archiving a deleted object', () => {
      expect(canTransition('deleted', 'archive')).toBe(false);
    });
  });

  describe('restore', () => {
    it('allows archived -> active', () => {
      expect(canTransition('archived', 'restore')).toBe(true);
    });

    it('allows deleted -> active (restore-from-deleted is explicitly required)', () => {
      expect(canTransition('deleted', 'restore')).toBe(true);
    });

    it('rejects restoring an already-active object', () => {
      expect(canTransition('active', 'restore')).toBe(false);
    });
  });

  describe('softDelete', () => {
    it('allows active -> deleted', () => {
      expect(canTransition('active', 'softDelete')).toBe(true);
    });

    it('allows archived -> deleted', () => {
      expect(canTransition('archived', 'softDelete')).toBe(true);
    });

    it('rejects soft-deleting an already-deleted object', () => {
      expect(canTransition('deleted', 'softDelete')).toBe(false);
    });
  });

  it('matches the full legality matrix for every (from, action) combination', () => {
    for (const from of allLifecycles) {
      for (const action of allActions) {
        expect(canTransition(from, action)).toBe(legalMatrix[from][action]);
      }
    }
  });
});
