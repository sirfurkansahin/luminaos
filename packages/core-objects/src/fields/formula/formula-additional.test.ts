import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { evaluateFormula } from './evaluator.js';
import { parseFormula } from './parser.js';
import { tokenize } from './tokenizer.js';

import type { FormulaValue } from './formula-value.js';

/**
 * Supplementary unit tests for `tokenizer.ts` / `parser.ts` / `evaluator.ts`
 * branches that the F1-T4 designed-signature contract in `parser.test.ts` /
 * `evaluator.test.ts` / `formula-fuzz.test.ts` does not itself exercise (e.g.
 * every individual function's own type-mismatch `FormulaErrorValue`, the six
 * comparison operators, decimal-number literal tokenization, string escape
 * sequences, and the call-argument branch of the `MAX_NESTING_DEPTH` guard).
 * This file is purely additive: it does not modify or weaken any of the
 * three spec-authoritative test files.
 */

function evaluate(
  expression: string,
  fieldValues: Record<string, unknown> = {},
  now: Date = new Date('2026-01-01T00:00:00.000Z'),
): FormulaValue {
  const { ast } = parseFormula(expression);
  return evaluateFormula(ast, { fieldValues, now });
}

function expectError(value: FormulaValue): void {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect((value as { formulaError?: unknown }).formulaError).toBe(true);
}

describe('tokenizer — decimal number literals', () => {
  it('tokenizes a decimal literal as a single number token', () => {
    const tokens = tokenize('3.5');

    expect(tokens[0]).toMatchObject({ type: 'number', value: '3.5' });
  });

  it('evaluates a decimal literal written directly in the expression', () => {
    expect(evaluate('1.5 + 1')).toBe(2.5);
  });
});

describe('tokenizer — string escape sequences', () => {
  it('tokenizes an escaped double quote inside a string literal', () => {
    const tokens = tokenize(String.raw`"a\"b"`);

    expect(tokens[0]).toMatchObject({ type: 'string', value: 'a"b' });
  });

  it('tokenizes an escaped backslash inside a string literal', () => {
    const tokens = tokenize(String.raw`"a\\b"`);

    expect(tokens[0]).toMatchObject({ type: 'string', value: 'a\\b' });
  });

  it('evaluates CONCAT with an escaped quote inside a string literal', () => {
    expect(evaluate(String.raw`CONCAT("say \"hi\"")`)).toBe('say "hi"');
  });
});

describe('parseFormula — MAX_NESTING_DEPTH guard via function-call arguments (not parens)', () => {
  it('rejects deeply nested function calls with ValidationError, not a stack overflow', () => {
    const deeplyNested = `${'NOT('.repeat(60)}TRUE${')'.repeat(60)}`;

    expect(() => parseFormula(deeplyNested)).toThrow(ValidationError);
  });
});

describe('evaluateFormula — comparison operators', () => {
  it('evaluates == for equal and unequal numbers', () => {
    expect(evaluate('1 == 1')).toBe(true);
    expect(evaluate('1 == 2')).toBe(false);
  });

  it('evaluates != for numbers', () => {
    expect(evaluate('1 != 2')).toBe(true);
    expect(evaluate('1 != 1')).toBe(false);
  });

  it('evaluates < and <= for numbers', () => {
    expect(evaluate('1 < 2')).toBe(true);
    expect(evaluate('2 <= 2')).toBe(true);
  });

  it('evaluates > and >= for numbers', () => {
    expect(evaluate('2 > 1')).toBe(true);
    expect(evaluate('2 >= 2')).toBe(true);
  });

  it('evaluates == for equal strings and booleans', () => {
    expect(evaluate('"a" == "a"')).toBe(true);
    expect(evaluate('TRUE == TRUE')).toBe(true);
  });

  it('produces a FormulaErrorValue when comparing operands of different types', () => {
    expectError(evaluate('1 == "1"'));
  });
});

describe('evaluateFormula — per-function type-mismatch errors not covered by the designed-signature suite', () => {
  it('IF errors when the condition is not a boolean', () => {
    expectError(evaluate('IF(1, 2, 3)'));
  });

  it('AND errors when an argument is not a boolean', () => {
    expectError(evaluate('AND(1, TRUE)'));
  });

  it('OR errors when an argument is not a boolean', () => {
    expectError(evaluate('OR(1, FALSE)'));
  });

  it('UPPER errors when the argument is not a string', () => {
    expectError(evaluate('UPPER(1)'));
  });

  it('LOWER errors when the argument is not a string', () => {
    expectError(evaluate('LOWER(1)'));
  });

  it('LEN errors when the argument is not a string', () => {
    expectError(evaluate('LEN(1)'));
  });

  it('MIN errors when an argument is not a number', () => {
    expectError(evaluate('MIN("a", 1)'));
  });

  it('MAX errors when an argument is not a number', () => {
    expectError(evaluate('MAX("a", 1)'));
  });

  it('ROUND errors when decimals is not a number', () => {
    expectError(evaluate('ROUND({x}, {d})', { x: 3.14159, d: 'not-a-number' }));
  });

  it('CONCAT errors when an argument is null (an unset-but-present field value)', () => {
    expectError(evaluate('CONCAT({x})', { x: null }));
  });

  it('unary minus errors when the operand is not a number', () => {
    expectError(evaluate('-{x}', { x: 'not-a-number' }));
  });

  it('DAYS_BETWEEN errors when an argument is not a date-like string', () => {
    expectError(evaluate('DAYS_BETWEEN({a}, {b})', { a: 1, b: '2026-01-01' }));
    expectError(evaluate('DAYS_BETWEEN({a}, {b})', { a: '2026-01-01', b: 'not-a-date' }));
  });
});

describe('evaluateFormula — field value coercion', () => {
  it('passes an explicit null field value through as null', () => {
    expect(evaluate('{x}', { x: null })).toBeNull();
  });

  it('errors when a field value is an unsupported type (e.g. an object)', () => {
    expectError(evaluate('{x}', { x: { nested: true } }));
  });
});
