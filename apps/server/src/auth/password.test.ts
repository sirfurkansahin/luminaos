import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

describe('hashPassword', () => {
  it('returns a non-empty string that is not the plaintext password', async () => {
    const plain = 'correct horse battery staple';

    const hash = await hashPassword(plain);

    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toBe(plain);
  });

  it('produces a hash encoded in the argon2id format', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('salts automatically: hashing the same plaintext twice yields different hashes', async () => {
    const plain = 'correct horse battery staple';

    const [first, second] = await Promise.all([hashPassword(plain), hashPassword(plain)]);

    expect(first).not.toBe(second);
  });
});

describe('verifyPassword', () => {
  it('returns true when the plaintext matches the hash it was derived from', async () => {
    const plain = 'correct horse battery staple';
    const hash = await hashPassword(plain);

    await expect(verifyPassword(hash, plain)).resolves.toBe(true);
  });

  it('returns false when the plaintext does not match the hash (wrong password)', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('returns false (not a throw) for a malformed/garbage hash string', async () => {
    await expect(verifyPassword('not-a-real-argon2-hash', 'anything')).resolves.toBe(false);
  });
});
