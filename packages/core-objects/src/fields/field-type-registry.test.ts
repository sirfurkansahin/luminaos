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

  describe('select / multiSelect config', () => {
    const types: FieldType[] = ['select', 'multiSelect'];

    it.each(types)('%s accepts non-empty unique options', (fieldType) => {
      expect(() => validateFieldConfig(fieldType, { options: ['a', 'b', 'c'] })).not.toThrow();
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

    it.each(types)('%s rejects duplicate option entries', (fieldType) => {
      expect(() => validateFieldConfig(fieldType, { options: ['a', 'a', 'b'] })).toThrow(
        ValidationError,
      );
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
    const config = { options: ['a', 'b', 'c'] };

    it('accepts a value present in the configured options', () => {
      expect(() => validateFieldValue('select', config, 'a')).not.toThrow();
    });

    it('rejects an option not present in the configured list (AC #2 literal example)', () => {
      expect(() => validateFieldValue('select', config, 'not-an-option')).toThrow(ValidationError);
    });

    it('rejects a non-string value', () => {
      expect(() => validateFieldValue('select', config, 1)).toThrow(ValidationError);
    });
  });

  describe('multiSelect', () => {
    const config = { options: ['a', 'b', 'c'] };

    it('accepts an array of valid options', () => {
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
