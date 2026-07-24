import { describe, expect, it } from 'vitest';

import { evaluateFormula } from './evaluator.js';
import { parseFormula } from './parser.js';

import type { FormulaValue } from './formula-value.js';

/**
 * Designed signatures (must be matched exactly by implementer):
 *
 *   evaluateFormula(
 *     ast: AstNode,
 *     context: { fieldValues: Record<string, unknown>; now: Date },
 *   ): FormulaValue
 *
 *   interface FormulaErrorValue { formulaError: true; message: string }
 *   type FormulaValue = number | string | boolean | null | FormulaErrorValue
 *
 * These tests exercise parser + evaluator together (`parseFormula(expr).ast`
 * feeds `evaluateFormula`), which is how the real code always uses them.
 *
 * Semantics pinned here:
 * - Evaluation NEVER throws for a well-formed (already-parsed) AST. Type
 *   mismatches, division by zero, and missing `{fieldKey}` values at
 *   evaluation time all produce a `FormulaErrorValue`, never a thrown error.
 * - Error propagation: if any operand/argument evaluates to a
 *   `FormulaErrorValue`, the containing expression short-circuits to an
 *   error value without invoking the operator's own logic.
 * - `TODAY()` reads `context.now` only, never the real wall clock.
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
  expect(typeof (value as { message?: unknown }).message).toBe('string');
}

describe('evaluateFormula — arithmetic', () => {
  it('respects precedence: {a} + {b} * {c}', () => {
    const result = evaluate('{a} + {b} * {c}', { a: 1, b: 2, c: 3 });

    expect(result).toBe(7);
  });

  it('evaluates subtraction, division, and modulo', () => {
    expect(evaluate('10 - 4')).toBe(6);
    expect(evaluate('10 / 4')).toBe(2.5);
    expect(evaluate('10 % 3')).toBe(1);
  });

  it('evaluates unary minus', () => {
    expect(evaluate('-{a}', { a: 5 })).toBe(-5);
  });
});

describe('evaluateFormula — string functions', () => {
  it('CONCAT joins string field values and literals', () => {
    expect(evaluate('CONCAT({first}, " ", {last})', { first: 'Ada', last: 'Lovelace' })).toBe(
      'Ada Lovelace',
    );
  });

  it('UPPER uppercases a string field value', () => {
    expect(evaluate('UPPER({x})', { x: 'hello' })).toBe('HELLO');
  });

  it('LOWER lowercases a string field value', () => {
    expect(evaluate('LOWER({x})', { x: 'HELLO' })).toBe('hello');
  });

  it('LEN returns the length of a string field value', () => {
    expect(evaluate('LEN({x})', { x: 'hello' })).toBe(5);
  });
});

describe('evaluateFormula — logic', () => {
  it('IF selects the then-branch when the condition is true', () => {
    expect(evaluate('IF({flag}, "yes", "no")', { flag: true })).toBe('yes');
  });

  it('IF selects the else-branch when the condition is false', () => {
    expect(evaluate('IF({flag}, "yes", "no")', { flag: false })).toBe('no');
  });

  it('AND is true only when every argument is true', () => {
    expect(evaluate('AND({a}, {b})', { a: true, b: true })).toBe(true);
    expect(evaluate('AND({a}, {b})', { a: true, b: false })).toBe(false);
  });

  it('OR is true when any argument is true', () => {
    expect(evaluate('OR({a}, {b})', { a: false, b: true })).toBe(true);
    expect(evaluate('OR({a}, {b})', { a: false, b: false })).toBe(false);
  });

  it('NOT negates a boolean', () => {
    expect(evaluate('NOT({a})', { a: true })).toBe(false);
    expect(evaluate('NOT({a})', { a: false })).toBe(true);
  });
});

describe('evaluateFormula — numeric functions', () => {
  it('ROUND with explicit decimal places', () => {
    expect(evaluate('ROUND({x}, 2)', { x: 3.14159 })).toBe(3.14);
  });

  it('ROUND defaults to 0 decimal places', () => {
    expect(evaluate('ROUND({x})', { x: 3.7 })).toBe(4);
  });

  it('ABS returns the absolute value', () => {
    expect(evaluate('ABS({x})', { x: -5 })).toBe(5);
  });

  it('MIN returns the smallest argument', () => {
    expect(evaluate('MIN({a}, {b}, {c})', { a: 3, b: 1, c: 2 })).toBe(1);
  });

  it('MAX returns the largest argument', () => {
    expect(evaluate('MAX({a}, {b}, {c})', { a: 3, b: 1, c: 2 })).toBe(3);
  });
});

describe('evaluateFormula — date functions', () => {
  it('TODAY() reflects the supplied context.now, never the real wall clock', () => {
    const { ast } = parseFormula('TODAY()');

    const resultA = evaluateFormula(ast, {
      fieldValues: {},
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const resultB = evaluateFormula(ast, {
      fieldValues: {},
      now: new Date('2030-06-15T00:00:00.000Z'),
    });

    expect(resultA).not.toEqual(resultB);
  });

  it('DAYS_BETWEEN computes a numeric day difference', () => {
    const result = evaluate('DAYS_BETWEEN({date1}, {date2})', {
      date1: '2026-01-01',
      date2: '2026-01-11',
    });

    expect(result).toBe(10);
  });
});

describe('evaluateFormula — type mismatches produce FormulaErrorValue, never a thrown error', () => {
  it('{a} + {b} errors when {a} resolves to a string', () => {
    const result = evaluate('{a} + {b}', { a: 'not-a-number', b: 1 });

    expectError(result);
  });

  it('ABS({x}) errors when {x} is a boolean', () => {
    const result = evaluate('ABS({x})', { x: true });

    expectError(result);
  });
});

describe('evaluateFormula — division by zero produces FormulaErrorValue', () => {
  it('{a} / {b} errors when {b} is 0, instead of Infinity/NaN/throwing', () => {
    const result = evaluate('{a} / {b}', { a: 10, b: 0 });

    expectError(result);
    expect(result).not.toBe(Infinity);
    expect(Number.isNaN(result)).toBe(false);
  });
});

describe('evaluateFormula — missing field reference produces FormulaErrorValue', () => {
  it('{nonexistent} not present in fieldValues errors with a "missing field" message', () => {
    const result = evaluate('{nonexistent}', {});

    expectError(result);
  });
});

describe('evaluateFormula — error propagation short-circuits the containing expression', () => {
  it('CONCAT("x: ", {a}/{b}) propagates a div-by-zero error from an argument', () => {
    const result = evaluate('CONCAT("x: ", {a}/{b})', { a: 1, b: 0 });

    expectError(result);
  });

  it('IF(true, {a}/{b}, 0) propagates an error from the selected branch', () => {
    const result = evaluate('IF(TRUE, {a}/{b}, 0)', { a: 1, b: 0 });

    expectError(result);
  });

  it('an arithmetic op propagates an error from one erroring operand', () => {
    const result = evaluate('1 + ({a}/{b})', { a: 1, b: 0 });

    expectError(result);
  });
});
