import { describe, expect, it } from 'vitest';

import { SENSITIVITY_TIERS, isSensitivityTier } from './sensitivity-tier.js';

/**
 * Designed signatures (must be matched exactly by implementer — F3-T12 PR1,
 * red step). Per `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md` Karar (b)
 * and `docs/specs/F3-E5/F3-T12-cihaz-ustu-model-koprusu.md`:
 *
 *   export type SensitivityTier = 'tier0' | 'tier1' | 'tier2' | 'tier3';
 *   export const SENSITIVITY_TIERS: readonly SensitivityTier[];
 *   export function isSensitivityTier(value: unknown): value is SensitivityTier;
 *
 * This is the kod-karşılığı of ADR-0029's four-kademe sensitive-data
 * classification (Kademe 0-3) — a CLOSED enum, exactly 4 values, no content
 * analysis anywhere in this file. `isSensitivityTier` is a pure type guard:
 * no I/O, no throwing, just a boolean membership check.
 */

describe('isSensitivityTier — valid values', () => {
  it.each(['tier0', 'tier1', 'tier2', 'tier3'] as const)(
    'returns true for the exact valid tier string %s',
    (value) => {
      expect(isSensitivityTier(value)).toBe(true);
    },
  );
});

describe('isSensitivityTier — invalid strings', () => {
  it.each(['tier4', 'TIER0', '', 'Tier1', ' tier0', 'tier0 '])(
    'returns false for the unrelated/malformed string %j',
    (value) => {
      expect(isSensitivityTier(value)).toBe(false);
    },
  );
});

describe('isSensitivityTier — non-string inputs', () => {
  it.each([undefined, null, 0, 1, {}, [], ['tier0'], true, false])(
    'returns false for the non-string input %j',
    (value) => {
      expect(isSensitivityTier(value)).toBe(false);
    },
  );
});

describe('SENSITIVITY_TIERS — the tier count is deliberately fixed at 4 (ADR-0029 four kademe)', () => {
  it('contains exactly the 4 tier values, in the tier0..tier3 order, no more and no less', () => {
    expect(SENSITIVITY_TIERS).toEqual(['tier0', 'tier1', 'tier2', 'tier3']);
    expect(SENSITIVITY_TIERS).toHaveLength(4);
  });

  it('every entry of SENSITIVITY_TIERS is itself recognized as a valid tier by isSensitivityTier', () => {
    for (const tier of SENSITIVITY_TIERS) {
      expect(isSensitivityTier(tier)).toBe(true);
    }
  });
});
