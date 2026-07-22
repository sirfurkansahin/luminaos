import { describe, expect, it } from 'vitest';

import { maskSensitiveFields } from './redact.js';

/**
 * Unit tests (no I/O) for F0-T8 PR-A's core PII-masking primitive, per the
 * approved plan (`giggly-brewing-moore.md`): `maskSensitiveFields(value)`
 * recursively walks any value and, for any object key whose name
 * case-insensitively matches
 * `/(email|password|token|secret|apikey|api_key|authorization|cookie)/i`,
 * replaces that key's VALUE (not the key itself) with the literal string
 * `'[REDACTED]'`. Everything else passes through unchanged.
 *
 * This is the function `formatters.log()` in `logging.module.ts` (PR-A, not
 * yet written) will call on every log object before pino serializes it — so
 * its correctness here is the entire proof behind AC2 ("log çıktısında
 * e-posta/şifre/token asla düz görünmez").
 *
 * NON-MUTATION CONVENTION CHOSEN FOR THIS TEST SUITE: a pure function that
 * hands back potentially-shared references from the input (objects/arrays it
 * decides NOT to touch) is fine and idiomatic for a structural-clone-style
 * walker, but it must never mutate the caller's original input in place —
 * a logging call site should never observe its own logged object change
 * out from under it. The "does not mutate input" test below asserts this by
 * keeping a reference to the original nested object and checking its
 * sensitive field is still the raw value after the call, while the
 * function's return value has it redacted.
 */

describe('maskSensitiveFields', () => {
  it('redacts a top-level object key matching "email" (exact, lowercase)', () => {
    const result = maskSensitiveFields({ email: 'user@example.com' });

    expect(result).toEqual({ email: '[REDACTED]' });
  });

  it('redacts keys matching password/token/secret/apikey/api_key/authorization/cookie', () => {
    const input = {
      password: 'hunter2',
      token: 'abc123',
      secret: 'shh',
      apikey: 'sk-1',
      api_key: 'sk-2',
      authorization: 'Bearer xyz',
      cookie: 'sid=abc',
    };

    expect(maskSensitiveFields(input)).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      secret: '[REDACTED]',
      apikey: '[REDACTED]',
      api_key: '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
    });
  });

  it('matches sensitive key names case-insensitively (Email, PASSWORD, ApiKey)', () => {
    const result = maskSensitiveFields({
      Email: 'user@example.com',
      PASSWORD: 'hunter2',
      ApiKey: 'sk-live-xyz',
    });

    expect(result).toEqual({
      Email: '[REDACTED]',
      PASSWORD: '[REDACTED]',
      ApiKey: '[REDACTED]',
    });
  });

  it('leaves non-matching keys and their values completely unchanged', () => {
    const result = maskSensitiveFields({ note: 'this is fine', count: 42, active: true });

    expect(result).toEqual({ note: 'this is fine', count: 42, active: true });
  });

  it('does not stringify or otherwise coerce non-sensitive primitive values', () => {
    const result = maskSensitiveFields({ count: 42, active: true, ratio: 3.14 }) as Record<
      string,
      unknown
    >;

    expect(result['count']).toBe(42);
    expect(typeof result['count']).toBe('number');
    expect(result['active']).toBe(true);
    expect(typeof result['active']).toBe('boolean');
    expect(result['ratio']).toBe(3.14);
  });

  it('redacts a sensitive key at arbitrary nested depth inside plain objects', () => {
    const result = maskSensitiveFields({
      level1: {
        level2: {
          level3: {
            email: 'nested@example.com',
            note: 'kept',
          },
        },
      },
    });

    expect(result).toEqual({
      level1: {
        level2: {
          level3: {
            email: '[REDACTED]',
            note: 'kept',
          },
        },
      },
    });
  });

  it('redacts sensitive keys inside objects that are elements of an array', () => {
    const result = maskSensitiveFields({
      users: [
        { email: 'a@example.com', name: 'A' },
        { email: 'b@example.com', name: 'B' },
      ],
    });

    expect(result).toEqual({
      users: [
        { email: '[REDACTED]', name: 'A' },
        { email: '[REDACTED]', name: 'B' },
      ],
    });
  });

  it('handles an array passed directly as the value (no wrapping object)', () => {
    const result = maskSensitiveFields([
      { token: 'abc123', note: 'kept' },
      { token: 'def456', note: 'also kept' },
    ]);

    expect(result).toEqual([
      { token: '[REDACTED]', note: 'kept' },
      { token: '[REDACTED]', note: 'also kept' },
    ]);
  });

  it('passes null through unchanged', () => {
    expect(maskSensitiveFields(null)).toBe(null);
  });

  it('passes undefined through unchanged', () => {
    expect(maskSensitiveFields(undefined)).toBe(undefined);
  });

  it('passes a null value under a sensitive key through as-is (nothing to redact)', () => {
    const result = maskSensitiveFields({ email: null });

    expect(result).toEqual({ email: null });
  });

  it('passes a bare top-level primitive through unchanged (no key context => no redaction)', () => {
    // A top-level string/number/boolean has no "key name" to test against the
    // sensitive-key pattern, even if the string content looks like a secret.
    expect(maskSensitiveFields('user@example.com')).toBe('user@example.com');
    expect(maskSensitiveFields(42)).toBe(42);
    expect(maskSensitiveFields(true)).toBe(true);
  });

  it('does not mutate the caller-supplied input object', () => {
    const original = { email: 'user@example.com', nested: { password: 'hunter2' } };

    const result = maskSensitiveFields(original) as {
      email: string;
      nested: { password: string };
    };

    // The function's return value has the sensitive fields redacted...
    expect(result.email).toBe('[REDACTED]');
    expect(result.nested.password).toBe('[REDACTED]');

    // ...but the ORIGINAL object the caller still holds a reference to must
    // be untouched -- a log call must never observe its own argument mutate.
    expect(original.email).toBe('user@example.com');
    expect(original.nested.password).toBe('hunter2');
  });

  it('terminates (does not hang or stack-overflow) on a circular reference', () => {
    const circular: Record<string, unknown> = { email: 'user@example.com' };
    circular['self'] = circular;

    expect(() => maskSensitiveFields(circular)).not.toThrow();
  }, 2_000);

  it('terminates on a deeply nested structure exceeding the depth cap without throwing', () => {
    // Per the plan, the walker caps recursion at 8 levels as a defense
    // against pathological/adversarial input. This test intentionally does
    // NOT assert the exact cutoff behavior (over-specifying an
    // implementation nuance) -- it only asserts the walker terminates
    // cleanly and returns a defined value on input far deeper than any
    // realistic log payload.
    let deep: Record<string, unknown> = { email: 'bottom@example.com' };
    for (let i = 0; i < 50; i += 1) {
      deep = { nested: deep };
    }

    let result: unknown;
    expect(() => {
      result = maskSensitiveFields(deep);
    }).not.toThrow();
    expect(result).toBeDefined();
  }, 2_000);
});
