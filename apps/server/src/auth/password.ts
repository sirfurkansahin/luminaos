import * as argon2 from 'argon2';

/**
 * Hashes a plaintext password with argon2id (the library's default), which
 * automatically generates a random salt per call — hashing the same
 * plaintext twice yields two different, equally valid hashes.
 */
export async function hashPassword(plain: string): Promise<string> {
  const hash: unknown = await argon2.hash(plain);
  return hash as string;
}

/**
 * Verifies a plaintext password against a previously produced argon2 hash.
 *
 * Any failure to verify — wrong password, or a malformed/garbage hash
 * string that argon2 can't even parse — resolves to `false` rather than
 * rejecting, so callers never need to special-case a thrown error just to
 * treat it as "not authenticated".
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
