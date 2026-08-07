import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, DecryptionError, encryptSecret } from './token-encryption.js';
import { AppError } from '../errors/app-error.js';

/**
 * F1-T12 PR1 (RED step) — reversible OAuth-token encryption utility, per
 * ADR-0012 §(c) (`docs/adr/ADR-0012-takvim-senkron.md`). Pins the exact
 * designed contract for `packages/shared/src/secrets/token-encryption.ts`,
 * which does not exist yet (this file is expected to fail to even resolve
 * its imports until `implementer` creates it):
 *
 *   encryptSecret(plaintext: string, key: Buffer): string
 *     -> AES-256-GCM. Generates a random 12-byte IV
 *        (`crypto.randomBytes(12)`), encrypts with
 *        `createCipheriv('aes-256-gcm', key, iv)`, and packs the result as
 *        `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`
 *        (colon-delimited, base64 segments).
 *
 *   decryptSecret(ciphertext: string, key: Buffer): string
 *     -> Parses the same `iv:authTag:ciphertext` format, reconstructs the
 *        buffers, and calls
 *        `createDecipheriv('aes-256-gcm', key, iv).setAuthTag(authTag)` then
 *        decrypts. Any failure — tampered ciphertext, wrong key, or a
 *        malformed packed string (wrong segment count, non-base64 content,
 *        wrong-length IV/authTag) — is caught/validated and rethrown as
 *        `DecryptionError`, never a raw native crypto/parse exception.
 *
 *   class DecryptionError extends AppError
 *     -> stable `.code`, `.statusCode` (500 — signals an internal/config
 *        problem such as a wrong or rotated key or data corruption, not a
 *        client input-validation error), generic message (never echoes the
 *        raw native crypto error, which could hint at internals).
 *
 * `key` is always a real 32-byte `Buffer` (AES-256 requires exactly 32
 * bytes); this pure module never reads env vars itself (that is a future
 * `env.ts` reader's job, out of scope for this PR).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/shared/src/secrets/token-encryption.ts` and re-exports it from
 * `packages/shared/src/secrets/index.ts` / `packages/shared/src/index.ts`.
 */
describe('token-encryption', () => {
  const key = randomBytes(32);

  describe('encryptSecret / decryptSecret round-trip', () => {
    it('round-trips a realistic OAuth-token-shaped plaintext', () => {
      const plaintext =
        'ya29.a0AfH6SMBx7f9k2LqP3rXyZ8vC1nQwE5tR6uI7oP8aS9dF0gH1jK2lM3nO4pQ5rS6tU7vW8xY9z';
      const packed = encryptSecret(plaintext, key);
      expect(decryptSecret(packed, key)).toBe(plaintext);
    });

    it('round-trips an empty string plaintext', () => {
      const packed = encryptSecret('', key);
      expect(decryptSecret(packed, key)).toBe('');
    });

    it('round-trips a plaintext containing the ":" delimiter character', () => {
      const plaintext = 'a:b:c';
      const packed = encryptSecret(plaintext, key);
      expect(decryptSecret(packed, key)).toBe(plaintext);
    });
  });

  it('produces a different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const plaintext = 'refresh-token-abc123';
    const first = encryptSecret(plaintext, key);
    const second = encryptSecret(plaintext, key);
    expect(first).not.toBe(second);
    // and both still decrypt to the same original plaintext
    expect(decryptSecret(first, key)).toBe(plaintext);
    expect(decryptSecret(second, key)).toBe(plaintext);
  });

  it('throws DecryptionError when the ciphertext segment is tampered with', () => {
    const packed = encryptSecret('super-secret-token', key);
    const segments = packed.split(':');
    const iv = segments[0] ?? '';
    const authTag = segments[1] ?? '';
    const ciphertext = segments[2] ?? '';
    // Flip one character in the ciphertext's base64 segment.
    const firstChar = ciphertext.charAt(0);
    const tamperedChar = firstChar === 'A' ? 'B' : 'A';
    const tamperedCiphertext = tamperedChar + ciphertext.slice(1);
    const tampered = `${iv}:${authTag}:${tamperedCiphertext}`;

    expect(() => decryptSecret(tampered, key)).toThrow(DecryptionError);
  });

  it('throws DecryptionError when decrypting with the wrong key', () => {
    const packed = encryptSecret('super-secret-token', key);
    const wrongKey = randomBytes(32);

    expect(() => decryptSecret(packed, wrongKey)).toThrow(DecryptionError);
  });

  it.each([
    ['no colons at all', 'not-encrypted-at-all'],
    ['only two segments', 'a:b'],
    ['four segments', 'a:b:c:d'],
    ['non-base64 content in every segment', '!!!:###:$$$'],
  ])('throws DecryptionError for malformed ciphertext (%s)', (_label, malformed) => {
    expect(() => decryptSecret(malformed, key)).toThrow(DecryptionError);
  });

  describe('DecryptionError', () => {
    it('is an instanceof Error and AppError', () => {
      const err = new DecryptionError();
      expect(err instanceof Error).toBe(true);
      expect(err instanceof AppError).toBe(true);
      expect(err instanceof DecryptionError).toBe(true);
    });

    it('has a stable, non-empty code', () => {
      const err = new DecryptionError();
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
    });

    it('has statusCode 500 (internal/config problem, not a client input error)', () => {
      expect(new DecryptionError().statusCode).toBe(500);
    });
  });
});
