import { describe, expect, it } from 'vitest';

import { evaluateCondition } from './condition-evaluator.js';

import type { ConditionSpec } from './trigger.js';

/**
 * F2-T15 PR1 (RED step) — `evaluateCondition(condition: ConditionSpec,
 * fieldValue: unknown): boolean` (ADR-0032 Karar e/g).
 *
 * Never throws (fail-closed for every non-string/unsafe input): a missing
 * or wrong-typed field value returns `false` (ADR-0032 Karar g's "eksik
 * alan-tanımı: zarif bozulma" — never fırlatma), and an unsafe
 * pattern/flags pair (which SHOULD have been rejected at write-time by
 * `trigger-commands.ts`, but could in principle reach here via a raw DB
 * edit) also returns `false` rather than throwing — a defensive read-time
 * re-check, per ADR-0032 Karar e.
 *
 * Layer 3 of ADR-0032 Karar e's ReDoS mitigation lives HERE, not in
 * `regex-safety.ts`: the tested field value is truncated to 5000 characters
 * BEFORE `.test()` is ever called, bounding worst-case blow-up even for a
 * pattern that slipped past `regex-safety.ts`'s static layer-2 rejection.
 *
 * EXPECTED LINT STATE (today, mirrors `./meeting-details.integration.test.ts`'s
 * documented convention): a single isolated `import-x/no-unresolved` finding
 * at the `./condition-evaluator.js` import, plus its natural
 * `@typescript-eslint/no-unsafe-*` cascade — clears once `implementer` adds
 * the real source file.
 */

const SAFE_CONDITION: ConditionSpec = {
  kind: 'condition',
  objectType: 'task',
  fieldKey: 'title',
  pattern: '^INV-\\d{4}$',
  flags: '',
  actionTemplate: { title: 'Follow up on invoice' },
};

describe('evaluateCondition', () => {
  it('returns true when fieldValue is a string matching pattern/flags', () => {
    expect(evaluateCondition(SAFE_CONDITION, 'INV-1234')).toBe(true);
  });

  it('returns false when fieldValue is a string that does not match', () => {
    expect(evaluateCondition(SAFE_CONDITION, 'not-an-invoice')).toBe(false);
  });

  it('respects the "i" flag for case-insensitive matching', () => {
    const condition: ConditionSpec = {
      ...SAFE_CONDITION,
      pattern: 'urgent',
      flags: 'i',
    };

    expect(evaluateCondition(condition, 'This is URGENT')).toBe(true);
  });

  it.each([null, undefined, 42, { nested: 'object' }, ['array', 'value']])(
    'returns false (never throws) when fieldValue is %j (missing/wrong-type field, ADR-0032 Karar g)',
    (fieldValue) => {
      expect(() => evaluateCondition(SAFE_CONDITION, fieldValue)).not.toThrow();
      expect(evaluateCondition(SAFE_CONDITION, fieldValue)).toBe(false);
    },
  );

  it('truncates fieldValue to 5000 characters before matching — a match that only occurs beyond the cap is NOT found', () => {
    const condition: ConditionSpec = {
      ...SAFE_CONDITION,
      pattern: 'NEEDLE',
      flags: '',
    };
    // 6000 chars total; "NEEDLE" starts at index 5500 -- entirely beyond the
    // 5000-char truncation boundary, so it must never be seen.
    const fieldValue = 'x'.repeat(5500) + 'NEEDLE' + 'x'.repeat(494);
    expect(fieldValue).toHaveLength(6000);

    expect(evaluateCondition(condition, fieldValue)).toBe(false);
  });

  it('still matches a needle that is well within the first 5000 characters', () => {
    const condition: ConditionSpec = {
      ...SAFE_CONDITION,
      pattern: 'NEEDLE',
      flags: '',
    };
    const fieldValue = 'x'.repeat(100) + 'NEEDLE' + 'x'.repeat(5894);
    expect(fieldValue).toHaveLength(6000);

    expect(evaluateCondition(condition, fieldValue)).toBe(true);
  });

  it('returns false (fail-closed, does not throw) when condition.pattern is unsafe (defensive read-time re-check)', () => {
    const unsafeCondition: ConditionSpec = {
      ...SAFE_CONDITION,
      pattern: '(a+)+',
      flags: '',
    };

    expect(() =>
      evaluateCondition(unsafeCondition, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'),
    ).not.toThrow();
    expect(
      evaluateCondition(unsafeCondition, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'),
    ).toBe(false);
  });

  it('returns false (fail-closed, does not throw) when condition.flags is unsafe (e.g. "g")', () => {
    const unsafeCondition: ConditionSpec = {
      ...SAFE_CONDITION,
      pattern: 'urgent',
      flags: 'g',
    };

    expect(() => evaluateCondition(unsafeCondition, 'urgent task')).not.toThrow();
    expect(evaluateCondition(unsafeCondition, 'urgent task')).toBe(false);
  });

  it('returns false (fail-closed, does not throw) when condition.pattern is not a syntactically valid regex', () => {
    const invalidCondition: ConditionSpec = {
      ...SAFE_CONDITION,
      pattern: '(',
      flags: '',
    };

    expect(() => evaluateCondition(invalidCondition, 'anything')).not.toThrow();
    expect(evaluateCondition(invalidCondition, 'anything')).toBe(false);
  });
});
