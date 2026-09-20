import { describe, expect, it } from 'vitest';

import { changePasswordSchema } from './change-password.schema.js';

describe('changePasswordSchema', () => {
  it('accepts a distinct new password with at least 12 characters', () => {
    expect(
      changePasswordSchema.parse({
        currentPassword: 'current-password',
        newPassword: 'new-secure-password',
      }),
    ).toEqual({ currentPassword: 'current-password', newPassword: 'new-secure-password' });
  });

  it('rejects short, reused, and unknown values', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'current-password',
        newPassword: 'short',
      }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'same-password',
        newPassword: 'same-password',
      }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'current-password',
        newPassword: 'new-secure-password',
        role: 'admin',
      }).success,
    ).toBe(false);
  });
});
