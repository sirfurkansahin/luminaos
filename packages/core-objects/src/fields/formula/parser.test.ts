import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { parseFormula } from './parser.js';

/**
 * Designed signatures (must be matched exactly by implementer):
 *
 *   parseFormula(expression: string): { ast: AstNode; dependsOn: string[] }
 *
 * Grammar (recursive descent):
 *
 *   expression      := comparison
 *   comparison      := additive ( ('=='|'!='|'<'|'<='|'>'|'>=') additive )?
 *   additive        := multiplicative ( ('+'|'-') multiplicative )*
 *   multiplicative  := unary ( ('*'|'/'|'%') unary )*
 *   unary           := '-' unary | primary
 *   primary         := NUMBER | STRING | TRUE | FALSE | fieldRef | call | '(' expression ')'
 *   fieldRef        := '{' IDENT '}'
 *   call            := FUNCTION_NAME '(' ( expression (',' expression)* )? ')'
 *
 * FUNCTION_NAME is case-insensitive, canonicalized upper-case, one of:
 * IF, AND, OR, NOT, ROUND, ABS, MIN, MAX, CONCAT, UPPER, LOWER, LEN, TODAY,
 * DAYS_BETWEEN. Arity is checked at PARSE time (ValidationError, never a
 * thrown native error):
 *   IF = 3, AND/OR >= 2, NOT = 1, ROUND = 1|2, ABS = 1, MIN/MAX >= 1,
 *   CONCAT >= 1, UPPER/LOWER/LEN = 1, TODAY = 0, DAYS_BETWEEN = 2.
 *
 * Unknown function names, malformed syntax (unbalanced parens, dangling
 * operators, empty input, empty `{}` field-ref, unterminated string
 * literals), an expression longer than MAX_EXPRESSION_LENGTH (assumed 2000
 * chars), and nesting deeper than MAX_NESTING_DEPTH (assumed 50 levels) all
 * throw `ValidationError` — never an uncaught native error
 * (RangeError/SyntaxError/TypeError) or a stack overflow.
 *
 * `dependsOn` collects every distinct `{fieldKey}` referenced anywhere in the
 * expression (including nested inside function calls), without duplicates.
 * We assert it via sorted-array/Set comparison rather than pinning raw
 * traversal order, since that's a legitimate implementer choice.
 */

function sortedDependsOn(expression: string): string[] {
  return [...parseFormula(expression).dependsOn].sort();
}

describe('parseFormula — grammar productions', () => {
  it('parses arithmetic precedence: 1 + 2 * 3 groups as 1 + (2 * 3)', () => {
    const { ast } = parseFormula('1 + 2 * 3');

    // We don't pin the exact AST node shape (that's the implementer's
    // choice), but we do pin that it parses without throwing and that the
    // resulting structure is an object (a real AST node, not a primitive).
    expect(ast).toBeTypeOf('object');
    expect(ast).not.toBeNull();
  });

  it('parses a comparison expression: {a} > {b}', () => {
    expect(() => parseFormula('{a} > {b}')).not.toThrow();
  });

  it('parses each comparison operator without throwing', () => {
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      expect(() => parseFormula(`{a} ${op} {b}`), `operator ${op}`).not.toThrow();
    }
  });

  it('parses unary minus', () => {
    expect(() => parseFormula('-{a}')).not.toThrow();
    expect(() => parseFormula('-5')).not.toThrow();
  });

  it('parses string and boolean literals', () => {
    expect(() => parseFormula('"hello"')).not.toThrow();
    expect(() => parseFormula('TRUE')).not.toThrow();
    expect(() => parseFormula('FALSE')).not.toThrow();
  });

  it('parses parenthesized sub-expressions', () => {
    expect(() => parseFormula('(1 + 2) * 3')).not.toThrow();
  });

  it('parses a field reference', () => {
    expect(() => parseFormula('{price}')).not.toThrow();
    expect(() => parseFormula('{my_field_key}')).not.toThrow();
  });

  it('parses a nested expression exercising most productions at once', () => {
    const expression = 'IF(AND({a}>0, NOT({b})), CONCAT({c},"!"), ROUND({d}, 2))';

    expect(() => parseFormula(expression)).not.toThrow();
  });
});

describe('parseFormula — dependsOn field collection', () => {
  it('collects a single field reference', () => {
    expect(sortedDependsOn('{price}')).toEqual(['price']);
  });

  it('collects every distinct field reference, including inside nested calls, without duplicates', () => {
    const expression = 'IF(AND({a}>0, NOT({b})), CONCAT({c},"!"), ROUND({d}, 2))';

    expect(sortedDependsOn(expression)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('deduplicates a field referenced multiple times', () => {
    expect(sortedDependsOn('{a} + {a} * {a}')).toEqual(['a']);
  });

  it('returns an empty array for an expression with no field references', () => {
    expect(sortedDependsOn('1 + 2 * 3')).toEqual([]);
  });
});

describe('parseFormula — case-insensitive function names', () => {
  it('parses if(...), If(...), and IF(...) identically', () => {
    const lower = parseFormula('if({a}, 1, 2)');
    const mixed = parseFormula('If({a}, 1, 2)');
    const upper = parseFormula('IF({a}, 1, 2)');

    expect(lower.ast).toEqual(mixed.ast);
    expect(mixed.ast).toEqual(upper.ast);
  });
});

describe('parseFormula — arity violations rejected at parse time', () => {
  it('rejects IF with only 2 args', () => {
    expect(() => parseFormula('IF({a}, {b})')).toThrow(ValidationError);
  });

  it('rejects IF with 4 args', () => {
    expect(() => parseFormula('IF({a}, {b}, {c}, {d})')).toThrow(ValidationError);
  });

  it('rejects TODAY with an argument', () => {
    expect(() => parseFormula('TODAY(1)')).toThrow(ValidationError);
  });

  it('accepts TODAY with zero arguments', () => {
    expect(() => parseFormula('TODAY()')).not.toThrow();
  });

  it('rejects NOT with zero args', () => {
    expect(() => parseFormula('NOT()')).toThrow(ValidationError);
  });

  it('rejects NOT with two args', () => {
    expect(() => parseFormula('NOT({a}, {b})')).toThrow(ValidationError);
  });

  it('rejects AND with only 1 arg (needs >= 2)', () => {
    expect(() => parseFormula('AND({a})')).toThrow(ValidationError);
  });

  it('accepts AND with 2 args', () => {
    expect(() => parseFormula('AND({a}, {b})')).not.toThrow();
  });

  it('rejects OR with only 1 arg (needs >= 2)', () => {
    expect(() => parseFormula('OR({a})')).toThrow(ValidationError);
  });

  it('rejects ROUND with zero args', () => {
    expect(() => parseFormula('ROUND()')).toThrow(ValidationError);
  });

  it('rejects ROUND with 3 args', () => {
    expect(() => parseFormula('ROUND({a}, 1, 2)')).toThrow(ValidationError);
  });

  it('accepts ROUND with 1 or 2 args', () => {
    expect(() => parseFormula('ROUND({a})')).not.toThrow();
    expect(() => parseFormula('ROUND({a}, 2)')).not.toThrow();
  });

  it('rejects ABS with zero args', () => {
    expect(() => parseFormula('ABS()')).toThrow(ValidationError);
  });

  it('rejects ABS with two args', () => {
    expect(() => parseFormula('ABS({a}, {b})')).toThrow(ValidationError);
  });

  it('rejects MIN with zero args', () => {
    expect(() => parseFormula('MIN()')).toThrow(ValidationError);
  });

  it('accepts MIN with a single arg', () => {
    expect(() => parseFormula('MIN({a})')).not.toThrow();
  });

  it('rejects MAX with zero args', () => {
    expect(() => parseFormula('MAX()')).toThrow(ValidationError);
  });

  it('rejects CONCAT with zero args', () => {
    expect(() => parseFormula('CONCAT()')).toThrow(ValidationError);
  });

  it('accepts CONCAT with a single arg', () => {
    expect(() => parseFormula('CONCAT({a})')).not.toThrow();
  });

  it('rejects UPPER with zero args', () => {
    expect(() => parseFormula('UPPER()')).toThrow(ValidationError);
  });

  it('rejects UPPER with two args', () => {
    expect(() => parseFormula('UPPER({a}, {b})')).toThrow(ValidationError);
  });

  it('rejects LOWER with zero args', () => {
    expect(() => parseFormula('LOWER()')).toThrow(ValidationError);
  });

  it('rejects LEN with zero args', () => {
    expect(() => parseFormula('LEN()')).toThrow(ValidationError);
  });

  it('rejects LEN with two args', () => {
    expect(() => parseFormula('LEN({a}, {b})')).toThrow(ValidationError);
  });

  it('rejects DAYS_BETWEEN with only 1 arg', () => {
    expect(() => parseFormula('DAYS_BETWEEN({a})')).toThrow(ValidationError);
  });

  it('rejects DAYS_BETWEEN with 3 args', () => {
    expect(() => parseFormula('DAYS_BETWEEN({a}, {b}, {c})')).toThrow(ValidationError);
  });

  it('accepts DAYS_BETWEEN with exactly 2 args', () => {
    expect(() => parseFormula('DAYS_BETWEEN({a}, {b})')).not.toThrow();
  });
});

describe('parseFormula — unknown function name', () => {
  it('rejects an unknown function name with ValidationError', () => {
    expect(() => parseFormula('BOGUS({a})')).toThrow(ValidationError);
  });
});

describe('parseFormula — malformed syntax rejected with ValidationError, never a native error', () => {
  it('rejects unbalanced parens (missing close)', () => {
    expect(() => parseFormula('(1 + 2')).toThrow(ValidationError);
  });

  it('rejects unbalanced parens (extra close)', () => {
    expect(() => parseFormula('1 + 2)')).toThrow(ValidationError);
  });

  it('rejects a dangling operator', () => {
    expect(() => parseFormula('1 +')).toThrow(ValidationError);
  });

  it('rejects empty input', () => {
    expect(() => parseFormula('')).toThrow(ValidationError);
  });

  it('rejects whitespace-only input', () => {
    expect(() => parseFormula('   ')).toThrow(ValidationError);
  });

  it('rejects an empty field-ref {}', () => {
    expect(() => parseFormula('{}')).toThrow(ValidationError);
  });

  it('rejects an unterminated string literal', () => {
    expect(() => parseFormula('"unterminated')).toThrow(ValidationError);
  });
});

describe('parseFormula — MAX_EXPRESSION_LENGTH guard', () => {
  it('rejects an expression longer than the maximum allowed length (assumed 2000 chars)', () => {
    const tooLong = `1${'+1'.repeat(1000)}`; // 2001 chars
    expect(tooLong.length).toBeGreaterThan(2000);

    expect(() => parseFormula(tooLong)).toThrow(ValidationError);
  });
});

describe('parseFormula — MAX_NESTING_DEPTH guard', () => {
  it('rejects deeply nested parens (60+ levels) with ValidationError, not a RangeError/stack overflow', () => {
    const deeplyNested = `${'('.repeat(60)}1${')'.repeat(60)}`;

    expect(() => parseFormula(deeplyNested)).toThrow(ValidationError);
  });
});
