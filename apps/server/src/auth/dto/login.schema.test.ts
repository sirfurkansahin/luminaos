import { describe, expect, it } from 'vitest';

import { loginSchema } from './login.schema.js';

describe('loginSchema', () => {
  describe('email', () => {
    it('accepts a valid email and lowercases + trims the parsed output', () => {
      const result = loginSchema.safeParse({
        email: '  Foo@Example.com  ',
        password: 'anything',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('foo@example.com');
      }
    });

    it('rejects a value that is not a valid email format', () => {
      const result = loginSchema.safeParse({
        email: 'not-an-email',
        password: 'anything',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('password', () => {
    it('rejects an empty-string password', () => {
      const result = loginSchema.safeParse({
        email: 'a@b.com',
        password: '',
      });

      expect(result.success).toBe(false);
    });

    it('accepts a short (4-character) password — login must not re-enforce registration length rules', () => {
      const result = loginSchema.safeParse({
        email: 'a@b.com',
        password: 'abcd',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.password).toBe('abcd');
      }
    });

    it('accepts a long, non-trivial password of any length', () => {
      const password = 'a'.repeat(500);
      const result = loginSchema.safeParse({
        email: 'a@b.com',
        password,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.password).toBe(password);
      }
    });
  });

  describe('strict mode (mass-assignment protection)', () => {
    it('rejects an object containing an unknown extra key such as isAdmin', () => {
      const result = loginSchema.safeParse({
        email: 'a@b.com',
        password: 'anything',
        isAdmin: true,
      });

      expect(result.success).toBe(false);
    });
  });
});
