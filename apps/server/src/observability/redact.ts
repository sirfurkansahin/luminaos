/**
 * Pure PII-masking primitive used by `logging.module.ts`'s `formatters.log()`
 * hook (see that file for how pino wires this in) — see F0-T8 PR-A's plan
 * (`giggly-brewing-moore.md`) for the full rationale.
 *
 * `maskSensitiveFields` recursively walks a value and, for every object key
 * whose name case-insensitively matches `SENSITIVE_KEY_PATTERN`, replaces
 * that key's VALUE with the literal string `'[REDACTED]'`. Everything else
 * is returned unchanged.
 *
 * Deliberate scope limits (see `redact.test.ts` for the exact contract this
 * enforces):
 * - Only plain object literals (`{}` / `Object.create(null)`) and arrays are
 *   recursed into. Anything else (class instances — `Error`, `Date`,
 *   `Buffer`, Node's raw `http.IncomingMessage`/`ServerResponse`, etc.) is
 *   treated as an opaque leaf and passed through unchanged. This matters in
 *   practice: pino-http's automatic request/response log lines pass the raw
 *   `res` object to `formatters.log()` *before* pino's own `res` serializer
 *   runs (formatters run first — verified against the installed pino
 *   10.3.1's `_asJson` implementation), and that object graph is large,
 *   contains circular back-references (e.g. `res.socket._httpMessage ===
 *   res`), and is not something a PII-key-name scan should ever try to
 *   rewrite — rewriting it would also strip its prototype, breaking pino's
 *   downstream `res`/`err` serializers, which specifically check
 *   `instanceof Error`/expect real response objects.
 * - Circular references are guarded with a `WeakSet` used as an ancestor
 *   stack (added on entry, removed on exit of that node's subtree) so a
 *   genuine cycle is replaced with the string `'[Circular]'` instead of
 *   hanging or re-emitting the original (potentially unredacted) reference,
 *   while a value that is merely *shared* by two sibling branches (not an
 *   ancestor of itself) is still processed independently on each branch.
 * - Recursion is capped at `MAX_DEPTH` levels as a defense against
 *   pathological/adversarial input; beyond the cap, a value is returned
 *   as-is without further processing.
 * - The function never mutates its input: every plain object/array it
 *   actually processes is rebuilt as a new object/array.
 */

const SENSITIVE_KEY_PATTERN = /(email|password|token|secret|apikey|api_key|authorization|cookie)/i;

const MAX_DEPTH = 8;

const REDACTED_MARKER = '[REDACTED]';
const CIRCULAR_MARKER = '[Circular]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return CIRCULAR_MARKER;
    }

    ancestors.add(value);
    const result = value.map((item) => walk(item, depth + 1, ancestors));
    ancestors.delete(value);
    return result;
  }

  if (isPlainObject(value)) {
    if (ancestors.has(value)) {
      return CIRCULAR_MARKER;
    }

    ancestors.add(value);
    const result: Record<string, unknown> = {};

    for (const [key, entryValue] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] =
          entryValue === null || entryValue === undefined ? entryValue : REDACTED_MARKER;
      } else {
        result[key] = walk(entryValue, depth + 1, ancestors);
      }
    }

    ancestors.delete(value);
    return result;
  }

  return value;
}

export function maskSensitiveFields(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}
