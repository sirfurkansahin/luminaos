import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { validateFieldConfig } from './field-type-registry.js';

/**
 * Regression tests from F1-T2 PR-A security review (Finding 1):
 * `select`/`multiSelect`'s `options` config had no upper bound on array
 * length or per-option string length. An admin-role workspace member (schema
 * management is admin-gated, but still an external actor relative to this
 * pure domain layer) could otherwise submit an unbounded `options` array,
 * forcing O(n) `Set` construction, zod-enum schema construction, and JSONB
 * persistence of an arbitrarily large config on every `defineField`/
 * `updateField`/value-validation call — a modest but real resource-exhaustion
 * surface. `validateFieldConfig` must reject configs beyond a reasonable
 * bound with `ValidationError`, not silently accept them.
 */

describe('select/multiSelect options config has bounded size (security regression)', () => {
  /**
   * F1-T10 PR1: fixtures migrated from the old plain-string `options` shape
   * to the new `{ value, label, isDone? }[]` option-object shape (Karar 2).
   * The bounds themselves (500 entries max, 200 chars max) are unchanged —
   * they now apply to `value` and `label` separately.
   */

  it('rejects an options array beyond the maximum entry count', () => {
    const tooManyOptions = Array.from({ length: 501 }, (_, i) => ({
      value: `option-${String(i)}`,
      label: `Option ${String(i)}`,
    }));

    expect(() => validateFieldConfig('select', { options: tooManyOptions })).toThrow(
      ValidationError,
    );
  });

  it('accepts an options array at the maximum entry count', () => {
    const maxOptions = Array.from({ length: 500 }, (_, i) => ({
      value: `option-${String(i)}`,
      label: `Option ${String(i)}`,
    }));

    expect(() => validateFieldConfig('select', { options: maxOptions })).not.toThrow();
  });

  it('rejects an option "value" beyond the maximum length', () => {
    const tooLongValue = 'x'.repeat(201);

    expect(() =>
      validateFieldConfig('multiSelect', { options: [{ value: tooLongValue, label: 'ok' }] }),
    ).toThrow(ValidationError);
  });

  it('rejects an option "label" beyond the maximum length', () => {
    const tooLongLabel = 'x'.repeat(201);

    expect(() =>
      validateFieldConfig('multiSelect', { options: [{ value: 'ok', label: tooLongLabel }] }),
    ).toThrow(ValidationError);
  });

  it('accepts an option whose "value" and "label" are both at the maximum length', () => {
    const maxLength = 'x'.repeat(200);

    expect(() =>
      validateFieldConfig('multiSelect', { options: [{ value: maxLength, label: maxLength }] }),
    ).not.toThrow();
  });
});
