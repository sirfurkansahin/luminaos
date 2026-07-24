import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import {
  isKnownFieldType,
  validateFieldConfig,
  validateFieldValue,
} from './field-type-registry.js';

/**
 * F1-T4 PR-A2 (RED step) — the 13th field type, `formula`.
 *
 * Designed API additions (per F1-T4 plan, pinned as a contract for
 * `implementer`; must be matched exactly):
 *
 *   FieldType gains a 'formula' member (13 total).
 *
 *   Config schema: `{ expression: string }` where `expression` is
 *   non-empty and at most 2000 characters (matching the formula expression
 *   engine's own `MAX_EXPRESSION_LENGTH`). `validateFieldConfig` does NOT
 *   itself check the expression is syntactically valid formula grammar —
 *   that's `defineField`/`updateField`'s job via `parseFormula`, one layer
 *   up (same type-agnostic-shape-checking separation as every other type
 *   here).
 *
 *   Value schema: a formula field's stored VALUE is a `FormulaValue`
 *   (`number | string | boolean | null | FormulaErrorValue`), i.e. the
 *   imported `formulaValueSchema` from `./formula/formula-value.js`.
 *
 * This file only covers the type-registry surface (`isKnownFieldType`,
 * `validateFieldConfig`, `validateFieldValue`) for the new type. It is a
 * NEW file, deliberately not appended to the existing
 * `field-type-registry.test.ts` / `field-type-registry-bounds.test.ts`
 * (left untouched, per task instructions).
 *
 * Expected to fail (red) until `implementer` adds the `'formula'` case to
 * `FieldType`, `FIELD_TYPES`, `parseConfigForType`, and `buildValueSchema`.
 */

describe('isKnownFieldType("formula")', () => {
  it('recognizes "formula" as a known field type', () => {
    expect(isKnownFieldType('formula')).toBe(true);
  });
});

describe('validateFieldConfig("formula", ...)', () => {
  it('accepts a config with a non-empty expression', () => {
    expect(() => validateFieldConfig('formula', { expression: '{a} + {b}' })).not.toThrow();
  });

  it('throws ValidationError when expression is missing entirely', () => {
    expect(() => validateFieldConfig('formula', {})).toThrow(ValidationError);
  });

  it('throws ValidationError when expression is an empty string', () => {
    expect(() => validateFieldConfig('formula', { expression: '' })).toThrow(ValidationError);
  });

  it('throws ValidationError when expression exceeds the maximum length of 2000 characters', () => {
    expect(() => validateFieldConfig('formula', { expression: 'x'.repeat(2001) })).toThrow(
      ValidationError,
    );
  });

  it('accepts an expression at exactly the maximum length of 2000 characters', () => {
    expect(() => validateFieldConfig('formula', { expression: 'x'.repeat(2000) })).not.toThrow();
  });

  it('throws ValidationError for a config carrying an unexpected extra key (strict schema)', () => {
    expect(() => validateFieldConfig('formula', { expression: '{a}', extra: 'nope' })).toThrow(
      ValidationError,
    );
  });
});

describe('validateFieldValue("formula", ...) — value is a FormulaValue', () => {
  const config = { expression: '{a} + {b}' };

  it('accepts a plain number result', () => {
    expect(() => validateFieldValue('formula', config, 42)).not.toThrow();
  });

  it('accepts a plain string result', () => {
    expect(() => validateFieldValue('formula', config, 'hello')).not.toThrow();
  });

  it('accepts a plain boolean result', () => {
    expect(() => validateFieldValue('formula', config, true)).not.toThrow();
  });

  it('accepts null', () => {
    expect(() => validateFieldValue('formula', config, null)).not.toThrow();
  });

  it('accepts a well-formed FormulaErrorValue', () => {
    expect(() =>
      validateFieldValue('formula', config, { formulaError: true, message: 'division by zero' }),
    ).not.toThrow();
  });

  it('rejects a FormulaErrorValue-shaped object missing "message"', () => {
    expect(() => validateFieldValue('formula', config, { formulaError: true })).toThrow(
      ValidationError,
    );
  });

  it('rejects an object that is not a valid FormulaValue shape at all', () => {
    expect(() => validateFieldValue('formula', config, { anything: 'else' })).toThrow(
      ValidationError,
    );
  });

  it('rejects an array (arrays are not a valid FormulaValue)', () => {
    expect(() => validateFieldValue('formula', config, [1, 2, 3])).toThrow(ValidationError);
  });

  it('rejects undefined', () => {
    expect(() => validateFieldValue('formula', config, undefined)).toThrow(ValidationError);
  });
});
