import { describe, expect, it } from 'vitest';

import { buildHealthCheckPayload } from './index.js';

describe('buildHealthCheckPayload', () => {
  it('returns an ok status payload', () => {
    expect(buildHealthCheckPayload()).toEqual({ status: 'ok' });
  });
});
