import { describe, expect, it } from 'vitest';

import { resolveListenPort } from './listen-port.js';

describe('resolveListenPort', () => {
  it('uses the local development default when PORT is absent', () => {
    expect(resolveListenPort(undefined)).toBe(3000);
  });

  it('uses a valid hosting-platform port', () => {
    expect(resolveListenPort('8080')).toBe(8080);
  });

  it.each(['', '0', '-1', '65536', '3000.5', 'not-a-port'])(
    'rejects invalid PORT values: %s',
    (rawPort) => {
      expect(() => resolveListenPort(rawPort)).toThrow('PORT');
    },
  );
});
