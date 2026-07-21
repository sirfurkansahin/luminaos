import { z } from 'zod';

/**
 * Validates a `POST /auth/register` request body.
 *
 * - `.strict()` rejects unknown keys (mass-assignment protection, e.g. a
 *   client trying to smuggle `isAdmin: true` into the payload).
 * - `email` is trimmed and lowercased *before* format validation so
 *   whitespace/casing differences never produce two "different" accounts
 *   for the same address.
 * - `password` length is bounded: too short is a weak-password risk, an
 *   unbounded length is a denial-of-service risk against the (deliberately
 *   slow) argon2 hashing step.
 */
export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(8).max(200),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
