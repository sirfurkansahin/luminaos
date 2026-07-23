import { describe, expect, it } from 'vitest';

import { isKnownObjectType, requiresTitle } from './object-type-registry.js';

/**
 * Designed API (per ADR-0003 "Tip genişletme"): a `Record<ObjectType, {
 * titleRequired: boolean }>` registry backs two pure accessors —
 * `isKnownObjectType(type: string): boolean` (a type guard usable on
 * untrusted/external strings, e.g. from an API body) and
 * `requiresTitle(type: ObjectType): boolean` (only meaningful for already-
 * known types; callers must narrow with `isKnownObjectType` first).
 */
describe('isKnownObjectType', () => {
  it('accepts "task"', () => {
    expect(isKnownObjectType('task')).toBe(true);
  });

  it('accepts "doc"', () => {
    expect(isKnownObjectType('doc')).toBe(true);
  });

  it('accepts "note"', () => {
    expect(isKnownObjectType('note')).toBe(true);
  });

  it('rejects an unknown type string', () => {
    expect(isKnownObjectType('project')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isKnownObjectType('')).toBe(false);
  });

  it('rejects a case-mismatched known type name', () => {
    expect(isKnownObjectType('Task')).toBe(false);
  });
});

describe('requiresTitle', () => {
  it('requires a title for "task"', () => {
    expect(requiresTitle('task')).toBe(true);
  });

  it('does not require a title for "doc"', () => {
    expect(requiresTitle('doc')).toBe(false);
  });

  it('does not require a title for "note"', () => {
    expect(requiresTitle('note')).toBe(false);
  });
});
