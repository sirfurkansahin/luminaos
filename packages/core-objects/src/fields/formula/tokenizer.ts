import { ValidationError } from '@luminaos/shared';

/**
 * Guard against pathological input BEFORE any scanning work happens — also
 * re-checked by `parser.ts`, but enforced here too since `tokenize` is
 * usable standalone.
 */
export const MAX_EXPRESSION_LENGTH = 2000;

export type TokenType = 'number' | 'string' | 'identifier' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

const TWO_CHAR_PUNCT = new Set(['==', '!=', '<=', '>=']);
const ONE_CHAR_PUNCT = new Set(['+', '-', '*', '/', '%', '(', ')', ',', '{', '}', '<', '>']);

/**
 * Splits `source` into a flat token stream, always ending with a single
 * `{ type: 'eof' }` sentinel so the parser never has to special-case running
 * off the end of the array. Throws `ValidationError` (never a native error)
 * for any lexical problem: input too long, an unterminated string literal, or
 * an unrecognized character.
 */
export function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ValidationError(
      `formula expression exceeds maximum length of ${String(MAX_EXPRESSION_LENGTH)} characters`,
    );
  }

  const tokens: Token[] = [];
  const length = source.length;
  let i = 0;

  while (i < length) {
    const ch = source[i] ?? '';

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    if (ch === '"') {
      const start = i;
      let value = '';
      i += 1;
      let closed = false;

      while (i < length) {
        const c = source[i] ?? '';

        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }

        if (c === '\\') {
          const next = source[i + 1];

          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }

          value += c;
          i += 1;
          continue;
        }

        value += c;
        i += 1;
      }

      if (!closed) {
        throw new ValidationError('unterminated string literal in formula expression');
      }

      tokens.push({ type: 'string', value, position: start });
      continue;
    }

    if (DIGIT.test(ch)) {
      const start = i;
      let value = '';

      while (i < length && DIGIT.test(source[i] ?? '')) {
        value += source[i] ?? '';
        i += 1;
      }

      if (source[i] === '.' && DIGIT.test(source[i + 1] ?? '')) {
        value += '.';
        i += 1;

        while (i < length && DIGIT.test(source[i] ?? '')) {
          value += source[i] ?? '';
          i += 1;
        }
      }

      tokens.push({ type: 'number', value, position: start });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      let value = '';

      while (i < length && IDENT_CONT.test(source[i] ?? '')) {
        value += source[i] ?? '';
        i += 1;
      }

      tokens.push({ type: 'identifier', value, position: start });
      continue;
    }

    const two = source.slice(i, i + 2);

    if (TWO_CHAR_PUNCT.has(two)) {
      tokens.push({ type: 'punct', value: two, position: i });
      i += 2;
      continue;
    }

    if (ONE_CHAR_PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch, position: i });
      i += 1;
      continue;
    }

    throw new ValidationError(`unrecognized character in formula expression: "${ch}"`);
  }

  tokens.push({ type: 'eof', value: '', position: length });

  return tokens;
}
