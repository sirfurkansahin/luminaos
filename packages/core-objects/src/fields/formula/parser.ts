import { ValidationError } from '@luminaos/shared';

import { tokenize, MAX_EXPRESSION_LENGTH } from './tokenizer.js';

import type { AstNode, BinaryOp, FunctionName } from './ast.js';
import type { Token } from './tokenizer.js';

/**
 * Caps how many levels of user-controlled recursion (parenthesized
 * sub-expressions and function-call arguments) the parser will descend into.
 * Enforced BEFORE recursing, so pathological input (e.g. 500 nested parens)
 * throws a `ValidationError` well before the JS call stack itself would be at
 * risk.
 */
const MAX_NESTING_DEPTH = 50;

const FUNCTION_NAMES: readonly FunctionName[] = [
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
];

const FUNCTION_NAME_SET: ReadonlySet<string> = new Set(FUNCTION_NAMES);

function isFunctionName(value: string): value is FunctionName {
  return FUNCTION_NAME_SET.has(value);
}

const COMPARISON_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ADDITIVE_OPS: ReadonlySet<string> = new Set(['+', '-']);
const MULTIPLICATIVE_OPS: ReadonlySet<string> = new Set(['*', '/', '%']);

const EOF_TOKEN: Token = { type: 'eof', value: '', position: -1 };

interface ParserState {
  tokens: Token[];
  pos: number;
}

function peek(state: ParserState): Token {
  return state.tokens[state.pos] ?? EOF_TOKEN;
}

function advance(state: ParserState): Token {
  const token = peek(state);
  state.pos += 1;
  return token;
}

function isPunct(token: Token, value: string): boolean {
  return token.type === 'punct' && token.value === value;
}

function expectPunct(state: ParserState, value: string): void {
  const token = peek(state);

  if (!isPunct(token, value)) {
    throw new ValidationError(`expected "${value}" in formula expression`);
  }

  advance(state);
}

function validateArity(name: FunctionName, argCount: number): void {
  switch (name) {
    case 'IF':
      if (argCount !== 3) {
        throw new ValidationError('IF expects exactly 3 arguments');
      }
      return;
    case 'TODAY':
      if (argCount !== 0) {
        throw new ValidationError('TODAY expects no arguments');
      }
      return;
    case 'DAYS_BETWEEN':
      if (argCount !== 2) {
        throw new ValidationError('DAYS_BETWEEN expects exactly 2 arguments');
      }
      return;
    case 'NOT':
    case 'ABS':
    case 'UPPER':
    case 'LOWER':
    case 'LEN':
      if (argCount !== 1) {
        throw new ValidationError(`${name} expects exactly 1 argument`);
      }
      return;
    case 'ROUND':
      if (argCount !== 1 && argCount !== 2) {
        throw new ValidationError('ROUND expects 1 or 2 arguments');
      }
      return;
    case 'AND':
    case 'OR':
      if (argCount < 2) {
        throw new ValidationError(`${name} expects at least 2 arguments`);
      }
      return;
    case 'MIN':
    case 'MAX':
    case 'CONCAT':
      if (argCount < 1) {
        throw new ValidationError(`${name} expects at least 1 argument`);
      }
  }
}

function parseFieldRef(state: ParserState): AstNode {
  expectPunct(state, '{');

  const token = peek(state);

  if (token.type !== 'identifier') {
    throw new ValidationError('expected a field key inside "{...}"');
  }

  advance(state);
  expectPunct(state, '}');

  return { kind: 'fieldRef', key: token.value };
}

function parseCallArguments(state: ParserState, depth: number): AstNode[] {
  const nextDepth = depth + 1;

  if (nextDepth > MAX_NESTING_DEPTH) {
    throw new ValidationError('formula expression exceeds maximum nesting depth');
  }

  const args: AstNode[] = [];

  if (!isPunct(peek(state), ')')) {
    args.push(parseExpression(state, nextDepth));

    while (isPunct(peek(state), ',')) {
      advance(state);
      args.push(parseExpression(state, nextDepth));
    }
  }

  expectPunct(state, ')');

  return args;
}

function parseCall(state: ParserState, depth: number, name: FunctionName): AstNode {
  advance(state); // consume the function-name identifier
  expectPunct(state, '(');

  const args = parseCallArguments(state, depth);

  validateArity(name, args.length);

  return { kind: 'call', name, args };
}

function parsePrimary(state: ParserState, depth: number): AstNode {
  const token = peek(state);

  if (token.type === 'number') {
    advance(state);

    // Safe by construction: `tokenizer.ts` only ever produces a `number`
    // token from a run of digits (and an optional `.` + more digits), which
    // `Number(...)` always parses successfully — there is no input that
    // reaches here with a value `Number(...)` would turn into `NaN`.
    return { kind: 'number', value: Number(token.value) };
  }

  if (token.type === 'string') {
    advance(state);
    return { kind: 'string', value: token.value };
  }

  if (token.type === 'identifier') {
    const upper = token.value.toUpperCase();

    if (upper === 'TRUE') {
      advance(state);
      return { kind: 'boolean', value: true };
    }

    if (upper === 'FALSE') {
      advance(state);
      return { kind: 'boolean', value: false };
    }

    if (isFunctionName(upper)) {
      return parseCall(state, depth, upper);
    }

    throw new ValidationError(`unknown identifier "${token.value}" in formula expression`);
  }

  if (token.type === 'punct' && token.value === '{') {
    return parseFieldRef(state);
  }

  if (token.type === 'punct' && token.value === '(') {
    advance(state);

    const nextDepth = depth + 1;

    if (nextDepth > MAX_NESTING_DEPTH) {
      throw new ValidationError('formula expression exceeds maximum nesting depth');
    }

    const inner = parseExpression(state, nextDepth);
    expectPunct(state, ')');

    return inner;
  }

  throw new ValidationError('unexpected token in formula expression');
}

function parseUnary(state: ParserState, depth: number): AstNode {
  const token = peek(state);

  if (isPunct(token, '-')) {
    advance(state);
    const operand = parseUnary(state, depth);
    return { kind: 'unary', op: '-', operand };
  }

  return parsePrimary(state, depth);
}

function parseMultiplicative(state: ParserState, depth: number): AstNode {
  let left = parseUnary(state, depth);

  for (;;) {
    const token = peek(state);

    if (token.type !== 'punct' || !MULTIPLICATIVE_OPS.has(token.value)) {
      break;
    }

    advance(state);
    const right = parseUnary(state, depth);
    left = { kind: 'binary', op: token.value as BinaryOp, left, right };
  }

  return left;
}

function parseAdditive(state: ParserState, depth: number): AstNode {
  let left = parseMultiplicative(state, depth);

  for (;;) {
    const token = peek(state);

    if (token.type !== 'punct' || !ADDITIVE_OPS.has(token.value)) {
      break;
    }

    advance(state);
    const right = parseMultiplicative(state, depth);
    left = { kind: 'binary', op: token.value as BinaryOp, left, right };
  }

  return left;
}

function parseComparison(state: ParserState, depth: number): AstNode {
  const left = parseAdditive(state, depth);
  const token = peek(state);

  if (token.type === 'punct' && COMPARISON_OPS.has(token.value)) {
    advance(state);
    const right = parseAdditive(state, depth);
    return { kind: 'binary', op: token.value as BinaryOp, left, right };
  }

  return left;
}

function parseExpression(state: ParserState, depth: number): AstNode {
  return parseComparison(state, depth);
}

function collectFieldRefs(root: AstNode): string[] {
  const keys = new Set<string>();
  const stack: AstNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === undefined) {
      continue;
    }

    switch (node.kind) {
      case 'fieldRef':
        keys.add(node.key);
        break;
      case 'binary':
        stack.push(node.left, node.right);
        break;
      case 'unary':
        stack.push(node.operand);
        break;
      case 'call':
        for (const arg of node.args) {
          stack.push(arg);
        }
        break;
      default:
        break;
    }
  }

  return [...keys].sort();
}

/**
 * Parses `expression` per the grammar documented in `parser.test.ts`'s
 * "Designed signatures" comment. Never throws anything other than
 * `ValidationError` — the whole body is wrapped so that any unexpected
 * native error (a bug on our side, or an adversarial fuzz input we didn't
 * anticipate) is converted rather than allowed to escape.
 */
export function parseFormula(expression: string): { ast: AstNode; dependsOn: string[] } {
  try {
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      throw new ValidationError(
        `formula expression exceeds maximum length of ${String(MAX_EXPRESSION_LENGTH)} characters`,
      );
    }

    const tokens = tokenize(expression);
    const state: ParserState = { tokens, pos: 0 };
    const ast = parseExpression(state, 0);
    const trailing = peek(state);

    if (trailing.type !== 'eof') {
      throw new ValidationError('unexpected trailing tokens in formula expression');
    }

    return { ast, dependsOn: collectFieldRefs(ast) };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ValidationError('invalid formula expression');
  }
}
