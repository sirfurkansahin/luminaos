import { describe, expect, it } from 'vitest';

import { slugify } from './index.js';

describe('slugify', () => {
  it('lowercases the input', () => {
    expect(slugify('HELLO')).toBe('hello');
  });

  it('trims leading/trailing whitespace', () => {
    expect(slugify('  hello  ')).toBe('hello');
  });

  it('replaces any run of one-or-more non-alphanumeric characters with a single hyphen', () => {
    expect(slugify('hello, world')).toBe('hello-world');
    expect(slugify('hello!!!world')).toBe('hello-world');
  });

  it('collapses consecutive hyphens into one', () => {
    expect(slugify('hello---world')).toBe('hello-world');
    expect(slugify('hello -- world')).toBe('hello-world');
  });

  it('strips leading/trailing hyphens from the result', () => {
    expect(slugify('-hello-world-')).toBe('hello-world');
    expect(slugify('!hello world!')).toBe('hello-world');
  });

  it('slugifies the canonical example', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
  });
});
