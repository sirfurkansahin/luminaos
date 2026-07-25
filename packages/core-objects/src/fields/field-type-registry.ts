import { z } from 'zod';

import { ValidationError } from '@luminaos/shared';

import { aiFieldErrorSchema } from './ai/ai-value.js';
import { formulaValueSchema } from './formula/formula-value.js';
import { MAX_EXPRESSION_LENGTH } from './formula/tokenizer.js';

/**
 * Per F1-T2 plan (PR-A) + F1-T4 plan (PR-A2) + F1-T5 plan (PR-B): 14
 * built-in field types.
 */
export type FieldType =
  | 'text'
  | 'longText'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multiSelect'
  | 'url'
  | 'email'
  | 'people'
  | 'currency'
  | 'formula'
  | 'ai';

const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'longText',
  'number',
  'checkbox',
  'date',
  'datetime',
  'select',
  'multiSelect',
  'url',
  'email',
  'people',
  'currency',
  'formula',
  'ai',
];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

/**
 * Type guard usable on untrusted/external strings (event payloads, API
 * bodies) — mirrors `object-type-registry.ts`'s `isKnownObjectType`.
 */
export function isKnownFieldType(type: string): type is FieldType {
  return FIELD_TYPE_SET.has(type);
}

// --- Config schemas -------------------------------------------------------
//
// `text` / `longText` / `checkbox` / `date` / `datetime` / `url` / `email` /
// `people` carry no configuration at all (an empty object). `number` takes
// optional `min`/`max` bounds. `select` / `multiSelect` require a non-empty,
// duplicate-free `options` list. `currency` requires a 3-letter uppercase
// ISO-4217-shaped `currencyCode`.

const emptyConfigSchema = z.object({}).strict();

const numberConfigSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
  .refine(
    (config) => config.min === undefined || config.max === undefined || config.min <= config.max,
    {
      message: 'min must be less than or equal to max',
    },
  );

/** Bounds chosen to keep config size/validation cost predictable (security review). */
const MAX_OPTIONS_COUNT = 500;
const MAX_OPTION_LENGTH = 200;

const optionsConfigSchema = z
  .object({
    options: z.array(z.string().min(1).max(MAX_OPTION_LENGTH)).min(1).max(MAX_OPTIONS_COUNT),
  })
  .strict()
  .refine((config) => new Set(config.options).size === config.options.length, {
    message: 'options must not contain duplicate entries',
  });

const currencyConfigSchema = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

/**
 * Per F1-T4 plan: `formula`'s config carries a single non-empty expression
 * string, capped at the formula expression engine's own
 * `MAX_EXPRESSION_LENGTH` (imported, not re-hardcoded). This schema does NOT
 * itself check the expression is syntactically valid formula grammar — that
 * is `defineField`/`updateField`'s job via `parseFormula`, one layer up.
 */
export const formulaConfigSchema = z
  .object({
    expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH),
  })
  .strict();

/**
 * Per F1-T5 plan: `ai`'s own prompt-template length cap — the same
 * length-cap style as `formulaConfigSchema`'s `expression`, but a
 * standalone constant (reusing the formula engine's `MAX_EXPRESSION_LENGTH`
 * would entangle two unrelated domains).
 */
const MAX_AI_PROMPT_TEMPLATE_LENGTH = 2000;

/**
 * Per F1-T5 plan: `ai`'s config carries a prompt template, the field keys it
 * may reference (`sourceFields`, possibly empty for a static prompt), an
 * output shape, and a refresh strategy. `options` reuses the same
 * `MAX_OPTIONS_COUNT`/`MAX_OPTION_LENGTH` bounds as `select`/`multiSelect`,
 * and is required (non-empty) when `outputType === 'select'`, forbidden
 * (must be `undefined`) when `outputType === 'text'`. This schema does NOT
 * itself check that `sourceFields` entries are known fields, or that
 * `promptTemplate` placeholders are well-formed — that is
 * `defineField`/`updateField`'s job via `assertAIFieldRules`, one layer up.
 */
export const aiConfigSchema = z
  .object({
    promptTemplate: z.string().min(1).max(MAX_AI_PROMPT_TEMPLATE_LENGTH),
    sourceFields: z.array(z.string()),
    outputType: z.enum(['text', 'select']),
    refreshMode: z.enum(['manual', 'onSourceChange']),
    options: z
      .array(z.string().min(1).max(MAX_OPTION_LENGTH))
      .min(1)
      .max(MAX_OPTIONS_COUNT)
      .optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.outputType === 'select' ? config.options !== undefined : config.options === undefined,
    {
      message:
        'options is required when outputType is "select" and forbidden when outputType is "text"',
    },
  );

/**
 * Parses `config` against `schema`; throws `ValidationError` (zod issues in
 * `details`, never a raw value interpolated into the message string — per
 * F1-T1 PR-A's security-review "unknown object type" fix) on failure,
 * otherwise returns the parsed/narrowed config.
 */
function parseConfig<T>(schema: z.ZodType<T>, fieldType: FieldType, config: unknown): T {
  const result = schema.safeParse(config);

  if (!result.success) {
    throw new ValidationError('invalid field config', { fieldType, issues: result.error.issues });
  }

  return result.data;
}

function parseConfigForType(fieldType: FieldType, config: unknown): unknown {
  switch (fieldType) {
    case 'text':
    case 'longText':
    case 'checkbox':
    case 'date':
    case 'datetime':
    case 'url':
    case 'email':
    case 'people':
      return parseConfig(emptyConfigSchema, fieldType, config);
    case 'number':
      return parseConfig(numberConfigSchema, fieldType, config);
    case 'select':
    case 'multiSelect':
      return parseConfig(optionsConfigSchema, fieldType, config);
    case 'currency':
      return parseConfig(currencyConfigSchema, fieldType, config);
    case 'formula':
      return parseConfig(formulaConfigSchema, fieldType, config);
    case 'ai':
      return parseConfig(aiConfigSchema, fieldType, config);
  }
}

/**
 * Builds the zod schema a VALUE for `fieldType` must satisfy, given its
 * (already-parsed) config. Config is re-parsed here too, so an invalid
 * config surfaces the same way whether the caller asked for config or value
 * validation.
 */
function buildValueSchema(fieldType: FieldType, config: unknown): z.ZodType {
  switch (fieldType) {
    case 'text':
    case 'longText': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.string();
    }
    case 'checkbox': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.boolean();
    }
    case 'date': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.iso.date();
    }
    case 'datetime': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.iso.datetime();
    }
    case 'url': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.url();
    }
    case 'email': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.email();
    }
    case 'people': {
      parseConfig(emptyConfigSchema, fieldType, config);
      return z.array(z.string().min(1));
    }
    case 'number': {
      const parsed = parseConfig(numberConfigSchema, fieldType, config);
      let schema = z.number();

      if (parsed.min !== undefined) {
        schema = schema.min(parsed.min);
      }

      if (parsed.max !== undefined) {
        schema = schema.max(parsed.max);
      }

      return schema;
    }
    case 'select': {
      const parsed = parseConfig(optionsConfigSchema, fieldType, config);
      return z.enum(parsed.options);
    }
    case 'multiSelect': {
      const parsed = parseConfig(optionsConfigSchema, fieldType, config);
      return z.array(z.enum(parsed.options));
    }
    case 'currency': {
      parseConfig(currencyConfigSchema, fieldType, config);
      return z.number();
    }
    case 'formula': {
      parseConfig(formulaConfigSchema, fieldType, config);
      return formulaValueSchema;
    }
    case 'ai': {
      const parsed = parseConfig(aiConfigSchema, fieldType, config);
      const successSchema =
        parsed.outputType === 'select' ? z.enum(parsed.options ?? []) : z.string();
      return z.union([successSchema, aiFieldErrorSchema]);
    }
  }
}

function assertKnownFieldType(fieldType: FieldType): void {
  const type: string = fieldType;

  if (!isKnownFieldType(type)) {
    throw new ValidationError('unknown field type', { fieldType });
  }
}

/**
 * Throws `ValidationError` if `config` is invalid for `fieldType` (including
 * an unknown `fieldType` itself); returns `true` on success. A `boolean`
 * (not `void`) return, mirroring `apps/server/src/observability/redact.ts`'s
 * `maskSensitiveFields` convention, keeps the common
 * `expect(() => validateFieldConfig(...)).not.toThrow()` shorthand-arrow
 * call site free of `@typescript-eslint/no-confusing-void-expression`.
 */
export function validateFieldConfig(fieldType: FieldType, config: unknown): true {
  assertKnownFieldType(fieldType);
  parseConfigForType(fieldType, config);
  return true;
}

/**
 * Throws `ValidationError` if `value` is invalid for `fieldType` + `config`
 * (including an unknown `fieldType` itself, or an invalid `config`); returns
 * `true` on success (see `validateFieldConfig`'s doc comment for why not
 * `void`).
 */
export function validateFieldValue(fieldType: FieldType, config: unknown, value: unknown): true {
  assertKnownFieldType(fieldType);

  const valueSchema = buildValueSchema(fieldType, config);
  const result = valueSchema.safeParse(value);

  if (!result.success) {
    throw new ValidationError('invalid field value', { fieldType, issues: result.error.issues });
  }

  return true;
}
