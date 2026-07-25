import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import {
  isKnownFieldType,
  validateFieldConfig,
  validateFieldValue,
} from './field-type-registry.js';

/**
 * F1-T5 PR-B (RED step) — the 14th field type, `ai`.
 *
 * Designed API additions (per F1-T5 plan, pinned as a contract for
 * `implementer`; must be matched exactly), following the SAME
 * type-agnostic-shape-checking separation as every other type in
 * `field-type-registry.ts` (config-shape validation only here; the
 * ai-gateway prompt/source-field semantics live one layer up in
 * `field-commands.ts`'s new `assertAIFieldRules`, pinned separately in
 * `field-commands-ai.test.ts`):
 *
 *   FieldType gains an 'ai' member (14 total).
 *
 *   New exported `aiConfigSchema`, `.strict()`:
 *     {
 *       promptTemplate: string, non-empty, capped at 2000 characters (same
 *         length-cap style as `formulaConfigSchema`'s `expression`, reusing
 *         the formula engine's own `MAX_EXPRESSION_LENGTH` constant would
 *         entangle two unrelated domains, so `ai` gets its own 2000-char
 *         cap chosen for parity/consistency, not import-shared),
 *       sourceFields: string[] (array of referenced field keys; may be
 *         empty -- a static, non-interpolated prompt is legitimate),
 *       outputType: 'text' | 'select',
 *       refreshMode: 'manual' | 'onSourceChange',
 *       options?: string[], bounded by the SAME `MAX_OPTIONS_COUNT` (500) /
 *         `MAX_OPTION_LENGTH` (200) constants `select`/`multiSelect` use,
 *         REQUIRED (non-empty) when outputType === 'select', FORBIDDEN
 *         (must be undefined) when outputType === 'text'.
 *     }
 *
 *   `parseConfigForType`'s new 'ai' case parses via `aiConfigSchema`.
 *
 *   `buildValueSchema`'s new 'ai' case re-parses config via
 *   `aiConfigSchema`, then returns a value schema that is a union of:
 *     (a) the "success" shape -- `z.string()` when outputType === 'text',
 *         or `z.enum(options)` when outputType === 'select';
 *     (b) the imported `aiFieldErrorSchema` from `./ai/ai-value.js` (a
 *         stored `ai` field value can always legitimately be a well-formed
 *         error, same composition style as `formula`'s
 *         `formulaValueSchema`).
 *
 * This file only covers the type-registry surface (`isKnownFieldType`,
 * `validateFieldConfig`, `validateFieldValue`) for the new type. It is a
 * NEW file, deliberately not appended to the existing
 * `field-type-registry.test.ts` / `field-type-registry-formula.test.ts` /
 * `field-type-registry-bounds.test.ts` (all left untouched, per task
 * instructions).
 *
 * Expected to fail (red) until `implementer` adds the `'ai'` case to
 * `FieldType`, `FIELD_TYPES`, `parseConfigForType`, and `buildValueSchema`,
 * and adds `packages/core-objects/src/fields/ai/ai-value.ts`.
 */

const baseTextConfig = {
  promptTemplate: 'Summarize {notes}',
  sourceFields: ['notes'],
  outputType: 'text' as const,
  refreshMode: 'manual' as const,
};

const baseSelectConfig = {
  promptTemplate: 'Classify {notes}',
  sourceFields: ['notes'],
  outputType: 'select' as const,
  refreshMode: 'manual' as const,
  options: ['low', 'medium', 'high'],
};

describe('isKnownFieldType("ai")', () => {
  it('recognizes "ai" as a known field type', () => {
    expect(isKnownFieldType('ai')).toBe(true);
  });
});

describe('validateFieldConfig("ai", ...)', () => {
  it('accepts a text-output config with no options', () => {
    expect(() => validateFieldConfig('ai', baseTextConfig)).not.toThrow();
  });

  it('throws ValidationError when outputType is "select" but options is missing', () => {
    expect(() =>
      validateFieldConfig('ai', {
        ...baseTextConfig,
        outputType: 'select',
        options: undefined,
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when outputType is "text" but options is provided', () => {
    expect(() =>
      validateFieldConfig('ai', {
        ...baseTextConfig,
        outputType: 'text',
        options: ['a', 'b'],
      }),
    ).toThrow(ValidationError);
  });

  it('accepts a select-output config with a well-formed options list', () => {
    expect(() => validateFieldConfig('ai', baseSelectConfig)).not.toThrow();
  });

  it('throws ValidationError when promptTemplate is an empty string', () => {
    expect(() => validateFieldConfig('ai', { ...baseTextConfig, promptTemplate: '' })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when promptTemplate exceeds the maximum length of 2000 characters', () => {
    expect(() =>
      validateFieldConfig('ai', { ...baseTextConfig, promptTemplate: 'x'.repeat(2001) }),
    ).toThrow(ValidationError);
  });

  it('accepts a promptTemplate at exactly the maximum length of 2000 characters', () => {
    expect(() =>
      validateFieldConfig('ai', { ...baseTextConfig, promptTemplate: 'x'.repeat(2000) }),
    ).not.toThrow();
  });

  it('throws ValidationError when refreshMode is missing entirely', () => {
    const withoutRefreshMode = {
      promptTemplate: baseTextConfig.promptTemplate,
      sourceFields: baseTextConfig.sourceFields,
      outputType: baseTextConfig.outputType,
    };
    expect(() => validateFieldConfig('ai', withoutRefreshMode)).toThrow(ValidationError);
  });

  it('throws ValidationError when refreshMode is not one of the known values', () => {
    expect(() => validateFieldConfig('ai', { ...baseTextConfig, refreshMode: 'bogus' })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError for a config carrying an unexpected extra key (strict schema)', () => {
    expect(() => validateFieldConfig('ai', { ...baseTextConfig, extra: 'nope' })).toThrow(
      ValidationError,
    );
  });

  it('accepts an empty sourceFields array (a static, non-interpolated prompt)', () => {
    expect(() => validateFieldConfig('ai', { ...baseTextConfig, sourceFields: [] })).not.toThrow();
  });
});

describe('validateFieldValue("ai", ...) — text output', () => {
  it('accepts an AI-generated string', () => {
    expect(() => validateFieldValue('ai', baseTextConfig, 'some AI-generated text')).not.toThrow();
  });

  it('accepts a well-formed AI field error value', () => {
    expect(() =>
      validateFieldValue('ai', baseTextConfig, { aiFieldError: true, message: 'failed' }),
    ).not.toThrow();
  });

  it('rejects a value that is neither a string nor a valid error shape', () => {
    expect(() => validateFieldValue('ai', baseTextConfig, 42)).toThrow(ValidationError);
  });
});

describe('validateFieldValue("ai", ...) — select output', () => {
  it('accepts a value that is one of the defined options', () => {
    expect(() => validateFieldValue('ai', baseSelectConfig, 'medium')).not.toThrow();
  });

  it('rejects a value that is not one of the defined options', () => {
    expect(() => validateFieldValue('ai', baseSelectConfig, 'urgent')).toThrow(ValidationError);
  });

  it('accepts a well-formed AI field error value', () => {
    expect(() =>
      validateFieldValue('ai', baseSelectConfig, { aiFieldError: true, message: 'x' }),
    ).not.toThrow();
  });
});
