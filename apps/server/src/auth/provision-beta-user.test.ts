import { describe, expect, it, vi } from 'vitest';

import { ConflictError, ValidationError } from '@luminaos/shared';

import { parseProvisionInput, provisionBetaUser } from './provision-beta-user.js';

import type { Database } from '../db/client.js';

describe('beta user provisioning', () => {
  it('normalizes the email and enforces the registration password contract', () => {
    expect(parseProvisionInput(' Beta@Example.com ', 'secure-password')).toEqual({
      email: 'beta@example.com',
      password: 'secure-password',
    });
    expect(() => parseProvisionInput('beta@example.com', 'short')).toThrow(ValidationError);
  });

  it('hashes the password before inserting and never returns the hash', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'user-1', email: 'beta@example.com' }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Database;

    const result = await provisionBetaUser(db, 'beta@example.com', 'secure-password');

    const inserted = values.mock.calls[0]?.[0] as { email: string; passwordHash: string };
    expect(inserted.email).toBe('beta@example.com');
    expect(inserted.passwordHash).not.toBe('secure-password');
    expect(inserted.passwordHash).toMatch(/^\$argon2id\$/);
    expect(result).toEqual({ id: 'user-1', email: 'beta@example.com' });
  });

  it('surfaces duplicate accounts without exposing password material', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
    const values = vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(duplicate) });
    const db = { insert: vi.fn().mockReturnValue({ values }) } as unknown as Database;

    await expect(
      provisionBetaUser(db, 'beta@example.com', 'secure-password'),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
