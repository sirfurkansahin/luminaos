import { describe, expect, it } from 'vitest';

import { corePlaceholder } from './index.js';

describe('corePlaceholder', () => {
  it('returns the package placeholder string', () => {
    expect(corePlaceholder()).toBe('@luminaos/core-objects placeholder');
  });
});
