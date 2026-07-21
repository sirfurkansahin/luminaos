import { describe, expect, it } from 'vitest';

import { aiGatewayPlaceholder } from './index.js';

describe('aiGatewayPlaceholder', () => {
  it('returns the package placeholder string', () => {
    expect(aiGatewayPlaceholder()).toBe('@luminaos/ai-gateway placeholder');
  });
});
