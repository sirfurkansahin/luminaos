/**
 * Narrow, structural check for the shape `pg`/`node-postgres` errors have
 * (a `code` string property) without importing `pg`'s error class directly
 * or resorting to `any`. Extracted from the identical helper previously
 * duplicated in `auth/auth.service.ts` and `workspaces/workspaces.service.ts`.
 */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
