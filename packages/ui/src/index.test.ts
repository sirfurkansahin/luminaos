import { describe, expect, it } from 'vitest';

import { uiPlaceholder } from './index.js';

describe('uiPlaceholder', () => {
  it('returns the package placeholder string', () => {
    expect(uiPlaceholder()).toBe('@luminaos/ui placeholder');
  });
});
