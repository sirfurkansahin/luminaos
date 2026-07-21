export interface Env {
  databaseUrl: string;
}

/**
 * Reads and validates process-level environment configuration.
 *
 * This is a boot-time concern (fails the process fast before anything is
 * wired up), not a request-time concern, so — per the approved plan — it is
 * exempt from the `packages/shared/errors` convention that governs
 * request-lifecycle failures. A missing/empty `DATABASE_URL` is a
 * misconfiguration that should never let the process start serving traffic.
 */
function readEnv(): Env {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    process.stderr.write('FATAL: DATABASE_URL environment variable is not set.\n');
    process.exit(1);
  }

  return { databaseUrl };
}

export const env: Env = readEnv();
