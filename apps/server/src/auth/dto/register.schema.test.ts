import { describe, expect, it } from 'vitest';

import { registerSchema } from './register.schema.js';

describe('registerSchema', () => {
  describe('email', () => {
    it('accepts a valid email and lowercases + trims the parsed output', () => {
      const result = registerSchema.safeParse({
        email: '  Foo@Example.com  ',
        password: 'longenough1',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('foo@example.com');
      }
    });

    it('rejects a value that is not a valid email format', () => {
      const result = registerSchema.safeParse({
        email: 'not-an-email',
        password: 'longenough1',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('password', () => {
    it('rejects a password shorter than 8 characters', () => {
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        password: 'short',
      });

      expect(result.success).toBe(false);
    });

    it('rejects a password longer than 200 characters', () => {
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        password: 'a'.repeat(201),
      });

      expect(result.success).toBe(false);
    });

    it('accepts a password within the 8-200 char range and does not transform it', () => {
      const password = 'validPassword123';
      const result = registerSchema.safeParse({
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
      const result = registerSchema.safeParse({
        email: 'a@b.com',
        password: 'longenough1',
        isAdmin: true,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('success path shape', () => {
    it('parses a fully valid payload into the expected { email, password } shape', () => {
      const parsed = registerSchema.parse({
        email: '  User@Example.com  ',
        password: 'longenough1',
      });

      expect(parsed).toEqual({
        email: 'user@example.com',
        password: 'longenough1',
      });
    });
  });
});
