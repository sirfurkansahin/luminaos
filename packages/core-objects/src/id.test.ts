import { describe, expect, it } from 'vitest';

import { newObjectId } from './id.js';

describe('newObjectId', () => {
  it('returns a 26-character ULID string', () => {
    const id = newObjectId();

    expect(typeof id).toBe('string');
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('returns a different value on each call', () => {
    expect(newObjectId()).not.toBe(newObjectId());
  });
});
