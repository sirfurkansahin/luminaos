import { isFormulaError } from './formula-value.js';

import type { AstNode, BinaryOp, FunctionName } from './ast.js';
import type { FormulaErrorValue, FormulaValue } from './formula-value.js';

export interface FormulaEvaluationContext {
  fieldValues: Record<string, unknown>;
  now: Date;
}

function errorValue(message: string): FormulaErrorValue {
  return { formulaError: true, message };
}

function coerceFieldValue(raw: unknown, key: string): FormulaValue {
  if (raw === null) {
    return null;
  }

  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') {
    return raw;
  }

  return errorValue(`field "${key}" has an unsupported value type`);
}

function evaluateArithmetic(
  op: '+' | '-' | '*' | '/' | '%',
  left: number,
  right: number,
): FormulaValue {
  if (op === '+') {
    return left + right;
  }

  if (op === '-') {
    return left - right;
  }

  if (op === '*') {
    return left * right;
  }

  if (right === 0) {
    return errorValue('division by zero');
  }

  return op === '/' ? left / right : left % right;
}

function evaluateComparison(
  op: '==' | '!=' | '<' | '<=' | '>' | '>=',
  left: number | string | boolean,
  right: number | string | boolean,
): boolean {
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
  }
}

const ARITHMETIC_OPS: ReadonlySet<BinaryOp> = new Set(['+', '-', '*', '/', '%']);

function evaluateBinary(op: BinaryOp, left: FormulaValue, right: FormulaValue): FormulaValue {
  if (ARITHMETIC_OPS.has(op)) {
    if (typeof left !== 'number' || typeof right !== 'number') {
      return errorValue(`operator "${op}" requires numeric operands`);
    }

    return evaluateArithmetic(op as '+' | '-' | '*' | '/' | '%', left, right);
  }

  const sameType =
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'string' && typeof right === 'string') ||
    (typeof left === 'boolean' && typeof right === 'boolean');

  if (!sameType) {
    return errorValue(`comparison operator "${op}" requires operands of the same type`);
  }

  return evaluateComparison(op as '==' | '!=' | '<' | '<=' | '>' | '>=', left, right);
}

function parseDateValue(value: FormulaValue): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * `parseFormula` already guarantees a fixed argument count for these function
 * names at PARSE time (see `parser.ts`'s `validateArity`), so indexing here
 * is safe by construction — the casts below document that invariant instead
 * of reintroducing an unreachable runtime check `noUncheckedIndexedAccess`
 * would otherwise force on every call site.
 */
function evaluateCall(
  name: FunctionName,
  args: FormulaValue[],
  context: FormulaEvaluationContext,
): FormulaValue {
  switch (name) {
    case 'IF': {
      const [cond, thenValue, elseValue] = args as [FormulaValue, FormulaValue, FormulaValue];

      if (typeof cond !== 'boolean') {
        return errorValue('IF condition must be a boolean');
      }

      return cond ? thenValue : elseValue;
    }

    case 'AND':
      if (!args.every((arg) => typeof arg === 'boolean')) {
        return errorValue('AND requires boolean arguments');
      }

      return args.every((arg) => arg);

    case 'OR':
      if (!args.every((arg) => typeof arg === 'boolean')) {
        return errorValue('OR requires boolean arguments');
      }

      return args.some((arg) => arg);

    case 'NOT': {
      const [arg] = args as [FormulaValue];

      if (typeof arg !== 'boolean') {
        return errorValue('NOT requires a boolean argument');
      }

      return !arg;
    }

    case 'ROUND': {
      const [value, decimalsArg] = args as [FormulaValue, FormulaValue | undefined];

      if (typeof value !== 'number') {
        return errorValue('ROUND requires a numeric value');
      }

      const decimals = decimalsArg === undefined ? 0 : decimalsArg;

      if (typeof decimals !== 'number') {
        return errorValue('ROUND decimals must be numeric');
      }

      const factor = Math.pow(10, decimals);

      return Math.round(value * factor) / factor;
    }

    case 'ABS':
    case 'MIN':
    case 'MAX': {
      if (!args.every((arg) => typeof arg === 'number')) {
        return errorValue(`${name} requires numeric arguments`);
      }

      const numbers = args;

      if (name === 'ABS') {
        return Math.abs(numbers[0] as number);
      }

      return name === 'MIN' ? Math.min(...numbers) : Math.max(...numbers);
    }

    case 'CONCAT': {
      const parts: string[] = [];

      for (const arg of args) {
        if (typeof arg !== 'number' && typeof arg !== 'string' && typeof arg !== 'boolean') {
          return errorValue('CONCAT arguments must be number, string, or boolean');
        }

        parts.push(String(arg));
      }

      return parts.join('');
    }

    case 'UPPER':
    case 'LOWER': {
      const [arg] = args as [FormulaValue];

      if (typeof arg !== 'string') {
        return errorValue(`${name} requires a string argument`);
      }

      return name === 'UPPER' ? arg.toUpperCase() : arg.toLowerCase();
    }

    case 'LEN': {
      const [arg] = args as [FormulaValue];

      if (typeof arg !== 'string') {
        return errorValue('LEN requires a string argument');
      }

      return arg.length;
    }

    case 'TODAY':
      return context.now.toISOString().slice(0, 10);

    case 'DAYS_BETWEEN': {
      const [start, end] = args as [FormulaValue, FormulaValue];
      const startMs = parseDateValue(start);
      const endMs = parseDateValue(end);

      if (startMs === undefined || endMs === undefined) {
        return errorValue('DAYS_BETWEEN requires date-like string arguments');
      }

      const msPerDay = 24 * 60 * 60 * 1000;

      return Math.round((endMs - startMs) / msPerDay);
    }
  }
}

function evaluateNode(node: AstNode, context: FormulaEvaluationContext): FormulaValue {
  switch (node.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;

    case 'fieldRef': {
      const raw = context.fieldValues[node.key];

      if (raw === undefined) {
        return errorValue(`field "${node.key}" is not set`);
      }

      return coerceFieldValue(raw, node.key);
    }

    case 'unary': {
      const operand = evaluateNode(node.operand, context);

      if (isFormulaError(operand)) {
        return operand;
      }

      if (typeof operand !== 'number') {
        return errorValue('unary minus requires a numeric operand');
      }

      return -operand;
    }

    case 'binary': {
      const left = evaluateNode(node.left, context);

      if (isFormulaError(left)) {
        return left;
      }

      const right = evaluateNode(node.right, context);

      if (isFormulaError(right)) {
        return right;
      }

      return evaluateBinary(node.op, left, right);
    }

    case 'call': {
      const args: FormulaValue[] = [];

      for (const argNode of node.args) {
        const value = evaluateNode(argNode, context);

        if (isFormulaError(value)) {
          return value;
        }

        args.push(value);
      }

      return evaluateCall(node.name, args, context);
    }
  }
}

/**
 * Pure, synchronous evaluator over an AST produced by `parseFormula`. Never
 * throws — every failure mode (type mismatch, division by zero, a missing
 * `{fieldKey}`) is represented as a `FormulaErrorValue` instead. There is
 * deliberately no outer `try`/`catch` here: every operation this function
 * (and everything it calls) performs — `typeof` checks, `Math.*`,
 * `Date.parse`, string methods, array iteration — is incapable of throwing
 * for the `FormulaValue`-typed inputs it operates on, so a catch-all would
 * only ever wrap dead code.
 */
export function evaluateFormula(ast: AstNode, context: FormulaEvaluationContext): FormulaValue {
  return evaluateNode(ast, context);
}
