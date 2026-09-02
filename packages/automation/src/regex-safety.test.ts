import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { assertSafeRegexPattern } from './regex-safety.js';

/**
 * F2-T15 PR1 (RED step) — `assertSafeRegexPattern(pattern: string, flags:
 * string): void`, ADR-0032 Karar (e)'s dependency-free, 4-layer ReDoS
 * mitigation (explicitly documented as "mitigation, not a guarantee" — ReDoS
 * detection is undecidable in general):
 *
 *   1. Pattern length cap — 200 characters.
 *   2. Static rejection of nested-quantifier shapes (classic
 *      catastrophic-backtracking patterns, e.g. `(a+)+`).
 *   3. (evaluation-time input-length cap — NOT this function's job, see
 *      `condition-evaluator.ts`'s own test file.)
 *   4. Flag allow-list — only `i` accepted; `g`/`m`/`s`/`u`/`y` rejected.
 *
 * Throws `ValidationError` on any violation (including when the pattern
 * itself is not a syntactically valid regex — a raw `SyntaxError` must never
 * escape); does nothing (no return value) on success.
 *
 * EXPECTED LINT STATE (today, mirrors `./meeting-details.integration.test.ts`'s
 * documented convention): a single isolated `import-x/no-unresolved` finding
 * at the `./regex-safety.js` import, plus its natural
 * `@typescript-eslint/no-unsafe-*` cascade — clears once `implementer` adds
 * the real source file.
 */

describe('assertSafeRegexPattern', () => {
  it('throws ValidationError when the pattern exceeds 200 characters', () => {
    const longPattern = 'a'.repeat(201);

    expect(() => assertSafeRegexPattern(longPattern, '')).toThrow(ValidationError);
  });

  it('does not throw for a pattern exactly at the 200-character cap', () => {
    const exactPattern = 'a'.repeat(200);

    expect(() => assertSafeRegexPattern(exactPattern, '')).not.toThrow();
  });

  it.each(['(a+)+', '(a*)*', '(a|a)+'])(
    'throws ValidationError for a classic catastrophic-backtracking shape: %s',
    (pattern) => {
      expect(() => assertSafeRegexPattern(pattern, '')).toThrow(ValidationError);
    },
  );

  it('throws ValidationError for a case-varying repeated-alternation shape under the "i" flag (security-review finding: "(a|A)+" is exponential under case-insensitive matching, just like "(a|a)+")', () => {
    expect(() => assertSafeRegexPattern('(a|A)+', 'i')).toThrow(ValidationError);
  });

  it.each(['^INV-\\d{4}$', 'urgent', '\\bfoo\\b'])(
    'does not throw for a normal, safe pattern: %s',
    (pattern) => {
      expect(() => assertSafeRegexPattern(pattern, '')).not.toThrow();
    },
  );

  it.each(['g', 'gi', 'm', 'u', 's', 'y'])(
    'throws ValidationError when flags contain anything other than "i": "%s"',
    (flags) => {
      expect(() => assertSafeRegexPattern('urgent', flags)).toThrow(ValidationError);
    },
  );

  it.each(['', 'i'])('does not throw for allowed flags: "%s"', (flags) => {
    expect(() => assertSafeRegexPattern('urgent', flags)).not.toThrow();
  });

  it('throws ValidationError (never a raw SyntaxError) for a syntactically invalid regex, e.g. an unclosed group', () => {
    let caught: unknown;
    try {
      assertSafeRegexPattern('(', '');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
  });
});
