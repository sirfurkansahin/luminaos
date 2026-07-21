import { z } from 'zod';

/**
 * Validates a `POST /auth/login` request body.
 *
 * Unlike `registerSchema`, this intentionally does NOT re-enforce
 * registration-time password length rules (min 8 / max 200) — an existing
 * account's password may have been created under different rules in the
 * past, and login should reject on *mismatch*, not on shape. Only an empty
 * password is rejected outright, since it can never be a valid credential.
 */
export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(1),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
