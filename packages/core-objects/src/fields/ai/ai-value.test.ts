import { describe, expect, it } from 'vitest';

import { aiFieldErrorSchema, isAIFieldError } from './ai-value.js';

/**
 * F1-T5 PR-B (RED step) — the `ai` field type's stored-value shape.
 *
 * Designed API (per F1-T5 plan, pinned as a contract for `implementer`; must
 * be matched exactly), a direct structural parallel to F1-T4's
 * `FormulaErrorValue`/`isFormulaError`/`formulaValueSchema`
 * (`./formula/formula-value.ts`) but a DIFFERENT, standalone type — `ai`
 * fields do not reuse `formula`'s error type:
 *
 *   export interface AIFieldErrorValue { aiFieldError: true; message: string }
 *   export type AIValue = string | AIFieldErrorValue;
 *   export function isAIFieldError(value: AIValue): value is AIFieldErrorValue;
 *   export const aiFieldErrorSchema: z.ZodType<AIFieldErrorValue>;
 *
 * `isAIFieldError` narrows an `AIValue` (an ai-generated string OR an error
 * marker) the same way `isFormulaError` narrows a `FormulaValue`.
 * `aiFieldErrorSchema` validates just the error-marker shape on its own (the
 * field-type-registry's `buildValueSchema` composes it into a union with the
 * success shape, mirrored from `formulaValueSchema`'s composition).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/core-objects/src/fields/ai/ai-value.ts`.
 */

describe('isAIFieldError', () => {
  it('recognizes a well-formed AIFieldErrorValue', () => {
    expect(isAIFieldError({ aiFieldError: true, message: 'x' })).toBe(true);
  });

  it('returns false for a plain ai-generated string', () => {
    expect(isAIFieldError('some text')).toBe(false);
  });
});

describe('aiFieldErrorSchema', () => {
  it('accepts a well-formed AIFieldErrorValue', () => {
    expect(aiFieldErrorSchema.safeParse({ aiFieldError: true, message: 'x' }).success).toBe(true);
  });

  it('rejects an object missing "message"', () => {
    expect(aiFieldErrorSchema.safeParse({ aiFieldError: true }).success).toBe(false);
  });

  it('rejects an object where "aiFieldError" is not the literal true', () => {
    expect(aiFieldErrorSchema.safeParse({ aiFieldError: false, message: 'x' }).success).toBe(false);
  });

  it('rejects an unrelated object shape', () => {
    expect(aiFieldErrorSchema.safeParse({ anything: 'else' }).success).toBe(false);
  });
});
