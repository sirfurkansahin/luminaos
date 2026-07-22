import { z } from 'zod';

/**
 * Pino's own level enum (`fatal|error|warn|info|debug|trace|silent`) — kept
 * local rather than imported from `pino` so this module has no runtime
 * dependency on the logging stack, only a string-shape contract with it.
 */
const LOG_LEVEL_SCHEMA = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export type LogLevel = z.infer<typeof LOG_LEVEL_SCHEMA>;

export interface Env {
  databaseUrl: string;
  logLevel: LogLevel;
}

/**
 * Reads and validates process-level environment configuration.
 *
 * This is a boot-time concern (fails the process fast before anything is
 * wired up), not a request-time concern, so — per the approved plan — it is
 * exempt from the `packages/shared/errors` convention that governs
 * request-lifecycle failures. A missing/empty `DATABASE_URL` is a
 * misconfiguration that should never let the process start serving traffic.
 *
 * `LOG_LEVEL` is different: unlike `DATABASE_URL`, its absence is not a
 * misconfiguration — it just means "use the default" (`'info'`). Only an
 * explicitly-set-but-invalid value (not one of pino's known levels) is
 * treated as a fatal misconfiguration, same fail-fast style as
 * `DATABASE_URL`.
 */
function readEnv(): Env {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    process.stderr.write('FATAL: DATABASE_URL environment variable is not set.\n');
    process.exit(1);
  }

  return { databaseUrl, logLevel: readLogLevel() };
}

function readLogLevel(): LogLevel {
  const rawLogLevel = process.env['LOG_LEVEL'];

  if (rawLogLevel === undefined || rawLogLevel.trim() === '') {
    return 'info';
  }

  const result = LOG_LEVEL_SCHEMA.safeParse(rawLogLevel);

  if (!result.success) {
    process.stderr.write(
      `FATAL: LOG_LEVEL environment variable has an invalid value "${rawLogLevel}".\n`,
    );
    process.exit(1);
  }

  return result.data;
}

export const env: Env = readEnv();
