/**
 * drizzle-orm wraps every driver-level query failure in its own
 * `DrizzleQueryError`, moving the real `pg` error (the one carrying
 * `code`/`constraint`) onto `.cause` instead of spreading it onto itself.
 * Unwraps one level so callers can check the underlying `pg` error whether
 * it arrived bare (e.g. from a raw `pg.Pool` client) or drizzle-wrapped.
 */
function unwrapCause(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error;
}

/**
 * Narrow, structural check for the shape `pg`/`node-postgres` errors have
 * (a `code` string property) without importing `pg`'s error class directly
 * or resorting to `any`. Extracted from the identical helper previously
 * duplicated in `auth/auth.service.ts` and `workspaces/workspaces.service.ts`.
 */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  const inner = unwrapCause(error);
  return typeof inner === 'object' && inner !== null && 'code' in inner && inner.code === code;
}

/**
 * Like `hasPostgresErrorCode`, but also pins the check to a specific named
 * constraint (`error.constraint`, present on `23505` unique-violation errors
 * from `pg`). Used by `EventStoreService.append` to distinguish a
 * `(stream_id, version)` concurrency conflict — the only unique constraint
 * that can escape its transaction in that code path — from any other
 * unrelated `23505`.
 */
export function hasPostgresConstraintViolation(error: unknown, constraint: string): boolean {
  const inner = unwrapCause(error);
  return (
    typeof inner === 'object' &&
    inner !== null &&
    'code' in inner &&
    inner.code === '23505' &&
    'constraint' in inner &&
    inner.constraint === constraint
  );
}
