import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import {
  isKnownFieldType,
  validateFieldConfig,
  validateFieldValue,
} from './field-type-registry.js';

import type { FieldType } from './field-type-registry.js';

/**
 * Designed API (per F1-T2 plan, PR-A) — THE most important file for AC #1 /
 * AC #2:
 *
 *   type FieldType = 'text' | 'longText' | 'number' | 'checkbox' | 'date' |
 *     'datetime' | 'select' | 'multiSelect' | 'url' | 'email' | 'people' |
 *     'currency'
 *
 *   isKnownFieldType(type: string): type is FieldType
 *     -> mirrors object-type-registry.ts's isKnownObjectType.
 *
 *   validateFieldConfig(fieldType: FieldType, config: unknown): void
 *     -> throws ValidationError if config is invalid for the type.
 *
 *   validateFieldValue(fieldType: FieldType, config: unknown, value: unknown): void
 *     -> throws ValidationError if value is invalid for fieldType+config.
 *
 * Both validators throw ValidationError for an unknown fieldType too (tested
 * via an `as FieldType` cast, simulating an untrusted caller that has not
 * gone through TypeScript's own narrowing — same pattern as
 * commands-input-guard.test.ts).
 */

const ALL_FIELD_TYPES: FieldType[] = [
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
];

describe('isKnownFieldType', () => {
  it.each(ALL_FIELD_TYPES)('accepts "%s"', (fieldType) => {
    expect(isKnownFieldType(fieldType)).toBe(true);
  });

  it('rejects an unknown type string', () => {
    expect(isKnownFieldType('bogus')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isKnownFieldType('')).toBe(false);
  });

  it('rejects a case-mismatched known type name', () => {
    expect(isKnownFieldType('Text')).toBe(false);
  });
});

describe('validateFieldConfig', () => {
  describe('text / longText / checkbox / date / datetime / url / email / people accept an empty config', () => {
    const simpleTypes: FieldType[] = [
      'text',
      'longText',
      'checkbox',
      'date',
      'datetime',
      'url',
      'email',
      'people',
    ];

    it.each(simpleTypes)('%s', (fieldType) => {
      expect(() => validateFieldConfig(fieldType, {})).not.toThrow();
    });
  });

  describe('number config', () => {
    it('accepts an empty config (no bounds)', () => {
      expect(() => validateFieldConfig('number', {})).not.toThrow();
    });

    it('accepts a config with valid min/max bounds', () => {
      expect(() => validateFieldConfig('number', { min: 0, max: 100 })).not.toThrow();
    });

    it('rejects a config where min > max', () => {
      expect(() => validateFieldConfig('number', { min: 100, max: 0 })).toThrow(ValidationError);
    });
  });

  describe('select / multiSelect config (F1-T10 PR1: option-object shape {value, label, isDone?})', () => {
    const types: FieldType[] = ['select', 'multiSelect'];

    it.each(types)('%s accepts non-empty unique option objects', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, {
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
          ],
        }),
      ).not.toThrow();
    });

    it.each(types)('%s rejects a config with options missing entirely', (fieldType) => {
      expect(() => validateFieldConfig(fieldType, {})).toThrow(ValidationError);
    });

    it.each(types)('%s rejects an empty options array', (fieldType) => {
      expect(() => validateFieldConfig(fieldType, { options: [] })).toThrow(ValidationError);
    });

    it.each(types)('%s rejects a non-array options field', (fieldType) => {
      expect(() => validateFieldConfig(fieldType, { options: 'a,b,c' })).toThrow(ValidationError);
    });

    it.each(types)(
      '%s rejects the old plain-string-array shape (breaking change, no back-compat shim)',
      (fieldType) => {
        expect(() => validateFieldConfig(fieldType, { options: ['a', 'b', 'c'] })).toThrow(
          ValidationError,
        );
      },
    );

    it.each(types)('%s accepts an option with isDone: true', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, {
          options: [
            { value: 'todo', label: 'Yapılacak' },
            { value: 'done', label: 'Bitti', isDone: true },
          ],
        }),
      ).not.toThrow();
    });

    it.each(types)('%s accepts an option without isDone (it is optional)', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, { options: [{ value: 'a', label: 'A' }] }),
      ).not.toThrow();
    });

    it.each(types)('%s rejects duplicate option "value"s', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, {
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'A duplicate value' },
            { value: 'b', label: 'B' },
          ],
        }),
      ).toThrow(ValidationError);
    });

    it.each(types)(
      '%s allows two options with the SAME "label" but different "value"s (uniqueness is value-only, not label)',
      (fieldType) => {
        expect(() =>
          validateFieldConfig(fieldType, {
            options: [
              { value: 'a', label: 'Same Label' },
              { value: 'b', label: 'Same Label' },
            ],
          }),
        ).not.toThrow();
      },
    );

    it.each(types)('%s rejects an option missing "value"', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, { options: [{ label: 'A' } as unknown as string] }),
      ).toThrow(ValidationError);
    });

    it.each(types)('%s rejects an option missing "label"', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, { options: [{ value: 'a' } as unknown as string] }),
      ).toThrow(ValidationError);
    });

    it.each(types)(
      '%s rejects an option with an extra unknown key (.strict() per item)',
      (fieldType) => {
        expect(() =>
          validateFieldConfig(fieldType, {
            options: [{ value: 'a', label: 'A', extra: 'nope' } as unknown as string],
          }),
        ).toThrow(ValidationError);
      },
    );

    it.each(types)('%s rejects an option whose isDone is not a boolean', (fieldType) => {
      expect(() =>
        validateFieldConfig(fieldType, {
          options: [{ value: 'a', label: 'A', isDone: 'yes' } as unknown as string],
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('currency config', () => {
    it('accepts a valid 3-letter uppercase ISO-4217-shaped code', () => {
      expect(() => validateFieldConfig('currency', { currencyCode: 'USD' })).not.toThrow();
    });

    it('rejects a lowercase currency code', () => {
      expect(() => validateFieldConfig('currency', { currencyCode: 'usd' })).toThrow(
        ValidationError,
      );
    });

    it('rejects a 2-letter currency code', () => {
      expect(() => validateFieldConfig('currency', { currencyCode: 'US' })).toThrow(
        ValidationError,
      );
    });

    it('rejects a missing currencyCode', () => {
      expect(() => validateFieldConfig('currency', {})).toThrow(ValidationError);
    });
  });

  it('throws ValidationError for an unknown field type', () => {
    expect(() => validateFieldConfig('bogus' as FieldType, {})).toThrow(ValidationError);
  });
});

describe('validateFieldValue (AC #1: >=3 scenarios per type, mixing valid + invalid)', () => {
  describe('text', () => {
    it('accepts a non-empty string', () => {
      expect(() => validateFieldValue('text', {}, 'hello')).not.toThrow();
    });

    it('accepts an empty string', () => {
      expect(() => validateFieldValue('text', {}, '')).not.toThrow();
    });

    it('rejects a non-string value (number)', () => {
      expect(() => validateFieldValue('text', {}, 42)).toThrow(ValidationError);
    });
  });

  describe('longText', () => {
    it('accepts a long string', () => {
      expect(() => validateFieldValue('longText', {}, 'x'.repeat(5000))).not.toThrow();
    });

    it('accepts a short string', () => {
      expect(() => validateFieldValue('longText', {}, 'short')).not.toThrow();
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('longText', {}, 42)).toThrow(ValidationError);
    });
  });

  describe('number', () => {
    it('accepts a finite number', () => {
      expect(() => validateFieldValue('number', {}, 42)).not.toThrow();
    });

    it('accepts a value within the configured min/max range', () => {
      expect(() => validateFieldValue('number', { min: 0, max: 100 }, 50)).not.toThrow();
    });

    it('rejects a string value (AC #2 literal example: "number\'a string")', () => {
      expect(() => validateFieldValue('number', {}, '42')).toThrow(ValidationError);
    });

    it('rejects a value above the configured max', () => {
      expect(() => validateFieldValue('number', { min: 0, max: 100 }, 150)).toThrow(
        ValidationError,
      );
    });

    it('rejects a value below the configured min', () => {
      expect(() => validateFieldValue('number', { min: 10, max: 100 }, 5)).toThrow(ValidationError);
    });
  });

  describe('checkbox', () => {
    it('accepts true', () => {
      expect(() => validateFieldValue('checkbox', {}, true)).not.toThrow();
    });

    it('accepts false', () => {
      expect(() => validateFieldValue('checkbox', {}, false)).not.toThrow();
    });

    it('rejects a non-boolean value (e.g. "yes")', () => {
      expect(() => validateFieldValue('checkbox', {}, 'yes')).toThrow(ValidationError);
    });
  });

  describe('date', () => {
    it('accepts an ISO date string', () => {
      expect(() => validateFieldValue('date', {}, '2026-01-15')).not.toThrow();
    });

    it('rejects a non-date string', () => {
      expect(() => validateFieldValue('date', {}, 'not-a-date')).toThrow(ValidationError);
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('date', {}, 20260115)).toThrow(ValidationError);
    });
  });

  describe('datetime', () => {
    it('accepts an ISO datetime string with an offset', () => {
      expect(() => validateFieldValue('datetime', {}, '2026-01-15T10:30:00Z')).not.toThrow();
    });

    it('rejects a bare date without a time component', () => {
      expect(() => validateFieldValue('datetime', {}, '2026-01-15')).toThrow(ValidationError);
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('datetime', {}, 123)).toThrow(ValidationError);
    });
  });

  describe('select', () => {
    const config = {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
    };

    it('accepts a value present in the configured options\' "value"s', () => {
      expect(() => validateFieldValue('select', config, 'a')).not.toThrow();
    });

    it('rejects an option not present in the configured list (AC #2 literal example)', () => {
      expect(() => validateFieldValue('select', config, 'not-an-option')).toThrow(ValidationError);
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('select', config, 1)).toThrow(ValidationError);
    });

    it(
      'validates the stored value against options\' "value"s, not "label"s: a value equal to an ' +
        "option's value is valid, the same option's label is not",
      () => {
        const labelVsValueConfig = {
          options: [{ value: 'todo', label: 'Yapılacak' }],
        };

        expect(() => validateFieldValue('select', labelVsValueConfig, 'todo')).not.toThrow();
        expect(() => validateFieldValue('select', labelVsValueConfig, 'Yapılacak')).toThrow(
          ValidationError,
        );
      },
    );
  });

  describe('multiSelect', () => {
    const config = {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
    };

    it('accepts an array of valid option "value"s', () => {
      expect(() => validateFieldValue('multiSelect', config, ['a', 'b'])).not.toThrow();
    });

    it('accepts an empty array (no selections)', () => {
      expect(() => validateFieldValue('multiSelect', config, [])).not.toThrow();
    });

    it('rejects an array containing an option not in the list', () => {
      expect(() => validateFieldValue('multiSelect', config, ['a', 'not-an-option'])).toThrow(
        ValidationError,
      );
    });

    it('rejects a non-array value', () => {
      expect(() => validateFieldValue('multiSelect', config, 'a')).toThrow(ValidationError);
    });

    it('validates stored values against options\' "value"s, not "label"s', () => {
      const labelVsValueConfig = {
        options: [{ value: 'todo', label: 'Yapılacak' }],
      };

      expect(() => validateFieldValue('multiSelect', labelVsValueConfig, ['todo'])).not.toThrow();
      expect(() => validateFieldValue('multiSelect', labelVsValueConfig, ['Yapılacak'])).toThrow(
        ValidationError,
      );
    });
  });

  describe('url', () => {
    it('accepts a valid URL', () => {
      expect(() => validateFieldValue('url', {}, 'https://example.com')).not.toThrow();
    });

    it('rejects a non-URL string', () => {
      expect(() => validateFieldValue('url', {}, 'not a url')).toThrow(ValidationError);
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('url', {}, 123)).toThrow(ValidationError);
    });
  });

  describe('email', () => {
    it('accepts a valid email address', () => {
      expect(() => validateFieldValue('email', {}, 'user@example.com')).not.toThrow();
    });

    it('rejects a non-email string', () => {
      expect(() => validateFieldValue('email', {}, 'not-an-email')).toThrow(ValidationError);
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('email', {}, 123)).toThrow(ValidationError);
    });
  });

  describe('people', () => {
    it('accepts an array of non-empty id-shaped strings', () => {
      expect(() => validateFieldValue('people', {}, ['user-1', 'user-2'])).not.toThrow();
    });

    it('accepts an empty array (no assignees)', () => {
      expect(() => validateFieldValue('people', {}, [])).not.toThrow();
    });

    it('rejects a non-array value', () => {
      expect(() => validateFieldValue('people', {}, 'user-1')).toThrow(ValidationError);
    });

    it('rejects an array containing a non-string entry', () => {
      expect(() => validateFieldValue('people', {}, ['user-1', 42])).toThrow(ValidationError);
    });

    it('rejects an array containing an empty-string entry', () => {
      expect(() => validateFieldValue('people', {}, ['user-1', ''])).toThrow(ValidationError);
    });
  });

  describe('currency', () => {
    const config = { currencyCode: 'USD' };

    it('accepts a positive finite amount', () => {
      expect(() => validateFieldValue('currency', config, 42.5)).not.toThrow();
    });

    it('accepts zero', () => {
      expect(() => validateFieldValue('currency', config, 0)).not.toThrow();
    });

    it('rejects a non-number amount', () => {
      expect(() => validateFieldValue('currency', config, '42.50')).toThrow(ValidationError);
    });

    it('rejects NaN', () => {
      expect(() => validateFieldValue('currency', config, Number.NaN)).toThrow(ValidationError);
    });
  });

  describe('unknown field type', () => {
    it('throws ValidationError regardless of the value given', () => {
      expect(() => validateFieldValue('bogus' as FieldType, {}, 'anything')).toThrow(
        ValidationError,
      );
    });
  });
});
