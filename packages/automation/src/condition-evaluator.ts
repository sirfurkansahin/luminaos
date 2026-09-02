import { assertSafeRegexPattern } from './regex-safety.js';

import type { ConditionSpec } from './trigger.js';

/**
 * ADR-0032 Karar (e)/(g) — never throws (fail-closed): a missing/wrong-typed
 * field value returns `false` (Karar g), and an unsafe pattern/flags pair
 * (which SHOULD have been rejected at write-time, but could in principle
 * reach here via a raw DB edit) also returns `false` rather than throwing —
 * a defensive read-time re-check.
 *
 * Layer 3 of ADR-0032 Karar (e)'s ReDoS mitigation lives HERE: the tested
 * field value is truncated to 5000 characters BEFORE `.test()` is ever
 * called, bounding worst-case blow-up even for a pattern that slipped past
 * `regex-safety.ts`'s static layer-2 rejection.
 */
const MAX_FIELD_VALUE_LENGTH = 5000;

export function evaluateCondition(condition: ConditionSpec, fieldValue: unknown): boolean {
  if (typeof fieldValue !== 'string') {
    return false;
  }

  const truncated = fieldValue.slice(0, MAX_FIELD_VALUE_LENGTH);

  try {
    assertSafeRegexPattern(condition.pattern, condition.flags);
  } catch {
    return false;
  }

  try {
    const regex = new RegExp(condition.pattern, condition.flags);
    return regex.test(truncated);
  } catch {
    return false;
  }
}
