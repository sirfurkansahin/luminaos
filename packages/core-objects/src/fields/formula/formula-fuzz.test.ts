import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { parseFormula } from './parser.js';

/**
 * THE fast-check property test for the F1-T4 acceptance criterion: "Parser
 * fuzz/property testi: rastgele girdilerde asla crash yok — ya sonuç ya
 * tanımlı hata" (parseFormula must, for ANY input, either succeed or throw a
 * well-defined `ValidationError` — never let a bare native error
 * (TypeError/RangeError/SyntaxError/stack overflow) escape).
 *
 * Unlike `replay-property.test.ts` (a model-based command-sequence property
 * for a stateful domain invariant), this is classic fuzz-style property
 * testing: we don't track a model of "legal" inputs at all — the whole point
 * is throwing arbitrary/adversarial strings at a pure parser and asserting
 * it never crashes uncontrolled. `numRuns: 200` matches the existing
 * precedent in this repo for a mission-critical property worth extra CI time.
 */

function assertNeverCrashesUncontrolled(input: string): void {
  try {
    const result = parseFormula(input);
    expect(result).toBeTypeOf('object');
    expect(result).not.toBeNull();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
  }
}

describe('parseFormula fuzz property — raw arbitrary strings never crash uncontrolled', () => {
  it('for any string up to 500 chars, parseFormula either succeeds or throws ValidationError', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        assertNeverCrashesUncontrolled(input);
      }),
      { numRuns: 200 },
    );
  });
});

describe('parseFormula fuzz property — structured random token-stream strings never crash uncontrolled', () => {
  const numberToken = fc.integer().map((n) => String(n));
  const fieldRefToken = fc.string({ minLength: 1, maxLength: 10 }).map((s) => `{${s}}`);
  const operatorToken = fc.constantFrom(
    '+',
    '-',
    '*',
    '/',
    '%',
    '(',
    ')',
    ',',
    '==',
    '!=',
    '<',
    '<=',
    '>',
    '>=',
  );
  const functionNameToken = fc.constantFrom(
    'IF',
    'AND',
    'OR',
    'NOT',
    'ROUND',
    'ABS',
    'MIN',
    'MAX',
    'CONCAT',
    'UPPER',
    'LOWER',
    'LEN',
    'TODAY',
    'DAYS_BETWEEN',
  );
  const separatorToken = fc.constantFrom('', ' ', '  ');

  const tokenArbitrary = fc.oneof(numberToken, fieldRefToken, operatorToken, functionNameToken);

  const tokenStreamArbitrary = fc
    .array(fc.tuple(tokenArbitrary, separatorToken), { maxLength: 40 })
    .map((pairs) => pairs.map(([token, sep]) => `${token}${sep}`).join(''));

  it('for any random token-stream string, parseFormula either succeeds or throws ValidationError', () => {
    fc.assert(
      fc.property(tokenStreamArbitrary, (input) => {
        assertNeverCrashesUncontrolled(input);
      }),
      { numRuns: 200 },
    );
  });
});

describe('parseFormula — deep-nesting regression (deterministic, non-fuzz)', () => {
  it('throws ValidationError (MAX_NESTING_DEPTH guard) for 500 levels of nested parens, not a RangeError/stack overflow', () => {
    const deeplyNested = `${'('.repeat(500)}1${')'.repeat(500)}`;

    expect(() => parseFormula(deeplyNested)).toThrow(ValidationError);
  });
});
