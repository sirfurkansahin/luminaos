import { describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from './register-service-worker';

describe('registerServiceWorker', () => {
  it('registers the root-scoped worker in production', async () => {
    const register = vi.fn().mockResolvedValue(undefined);

    await expect(registerServiceWorker({ register }, true)).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing outside production or when unsupported', async () => {
    const register = vi.fn().mockResolvedValue(undefined);

    await expect(registerServiceWorker({ register }, false)).resolves.toBe(false);
    await expect(registerServiceWorker(undefined, true)).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('contains registration failures without blocking startup', async () => {
    const error = new Error('registration failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      registerServiceWorker({ register: vi.fn().mockRejectedValue(error) }, true),
    ).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith('Service worker registration failed', error);
  });
});
