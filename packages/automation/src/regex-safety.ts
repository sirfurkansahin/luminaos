import { ValidationError } from '@luminaos/shared';

/**
 * ADR-0032 Karar (e) — dependency-free, 4-layer ReDoS mitigation. This
 * function implements layers 1, 2, and 4 (layer 3, the evaluation-time
 * input-length cap, lives in `condition-evaluator.ts`). Explicitly a
 * mitigation, not a guarantee: ReDoS detection is undecidable in general.
 *
 * Throws `ValidationError` on any violation; never lets a raw `SyntaxError`
 * escape (a syntactically invalid pattern is re-thrown as `ValidationError`).
 */

const MAX_PATTERN_LENGTH = 200;
const ALLOWED_FLAGS = new Set(['i']);

/**
 * A conservative static check for the classic "nested quantifier" shape that
 * causes catastrophic backtracking: a group `(...)` whose own content itself
 * contains a quantifier (`+`/`*`/`{n,}`/`{n,m}`) or a repeated alternation
 * branch (`a|a`), followed immediately by an outer quantifier on that group
 * (`+`/`*`/`{n,}`/`{n,m}`).
 *
 * The repeated-alternation check must be case-folded whenever the pattern
 * will run with the `i` flag -- otherwise `(a|A)+` (semantically identical to
 * the rejected `(a|a)+` under case-insensitive matching, and just as
 * exponential) slips past as a literal-text mismatch. Confirmed exploitable:
 * `/^(a|A)+$/i.test('a'.repeat(30) + 'X')` does not return in under 15s.
 *
 * Deliberately narrow (better some false negatives on exotic ReDoS shapes
 * than rejecting legitimate patterns like `^INV-\d{4}$`, `urgent`, `\bfoo\b`).
 */
function hasNestedQuantifierShape(pattern: string, flags: string): boolean {
  const caseInsensitive = flags.includes('i');

  // Matches a parenthesized group followed by a quantifier on the group
  // itself, e.g. "(a+)+", "(a*)*", "(a|a)+".
  const groupThenQuantifier = /\(([^()]*)\)(?:[+*]|\{\d+,?\d*\})/g;

  let match: RegExpExecArray | null;
  while ((match = groupThenQuantifier.exec(pattern)) !== null) {
    const groupContent = match[1] ?? '';
    const foldedContent = caseInsensitive ? groupContent.toLowerCase() : groupContent;
    const innerHasQuantifier = /[+*]|\{\d+,?\d*\}/.test(groupContent);
    const innerHasRepeatedAlternation = /(.+)\|\1/.test(foldedContent);

    if (innerHasQuantifier || innerHasRepeatedAlternation) {
      return true;
    }
  }

  return false;
}

export function assertSafeRegexPattern(pattern: string, flags: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ValidationError('regex pattern exceeds the 200-character cap', {
      patternLength: pattern.length,
    });
  }

  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new ValidationError('regex flags must only contain "i"', { flags });
    }
  }

  if (hasNestedQuantifierShape(pattern, flags)) {
    throw new ValidationError(
      'regex pattern has a catastrophic-backtracking (nested-quantifier) shape',
      { pattern },
    );
  }

  try {
    new RegExp(pattern, flags);
  } catch {
    throw new ValidationError('regex pattern is not syntactically valid', { pattern, flags });
  }
}
