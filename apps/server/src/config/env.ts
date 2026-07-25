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
  redisUrl: string;
  /** Optional — `undefined` when absent/blank means "no real Anthropic key configured", the DI-layer signal (F1-T5 PR-C) to fall back to `MockProvider` instead of a real `AnthropicProvider`. */
  anthropicApiKey?: string;
  /** Cumulative `inputTokens + outputTokens` a workspace may consume across `ai_usage_records` before `refreshAIField` starts rejecting with `QuotaExceededError` (F1-T5 PR-C). Absent/blank -> default; present-but-invalid -> fatal. */
  aiTokenQuotaPerWorkspace: number;
  /** `AIRefreshScheduler`'s debounce window in milliseconds (F1-T5 PR-C). Absent/blank -> default (matches `AIRefreshScheduler`'s own pure default); present-but-invalid -> fatal. */
  aiRefreshDebounceMs: number;
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

  const redisUrl = process.env['REDIS_URL'];

  if (redisUrl === undefined || redisUrl.trim() === '') {
    process.stderr.write('FATAL: REDIS_URL environment variable is not set.\n');
    process.exit(1);
  }

  const anthropicApiKey = readAnthropicApiKey();

  return {
    databaseUrl,
    logLevel: readLogLevel(),
    redisUrl,
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
    aiTokenQuotaPerWorkspace: readPositiveIntegerEnv(
      'AI_TOKEN_QUOTA_PER_WORKSPACE',
      DEFAULT_AI_TOKEN_QUOTA_PER_WORKSPACE,
    ),
    aiRefreshDebounceMs: readPositiveIntegerEnv(
      'AI_REFRESH_DEBOUNCE_MS',
      DEFAULT_AI_REFRESH_DEBOUNCE_MS,
    ),
  };
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

/**
 * `ANTHROPIC_API_KEY` (F1-T5 PR-C): absent/blank -> `undefined` (never
 * fatal — this is the DI layer's signal to fall back to `MockProvider`, see
 * task-level doc comment). Any non-blank value is accepted as-is, verbatim,
 * with no shape validation — a malformed key is the real Anthropic SDK's
 * concern at CALL time, not this boot-time reader's.
 */
function readAnthropicApiKey(): string | undefined {
  const rawApiKey = process.env['ANTHROPIC_API_KEY'];

  if (rawApiKey === undefined || rawApiKey.trim() === '') {
    return undefined;
  }

  return rawApiKey;
}

/** `AI_TOKEN_QUOTA_PER_WORKSPACE`'s own default (F1-T5 PR-C design decision — one million total input+output tokens per workspace). */
const DEFAULT_AI_TOKEN_QUOTA_PER_WORKSPACE = 1_000_000;

/** `AI_REFRESH_DEBOUNCE_MS`'s own default — matches `AIRefreshScheduler`'s pure default so `new AIRefreshScheduler(env.aiRefreshDebounceMs)` and `new AIRefreshScheduler()` behave identically when this env var is unset. */
const DEFAULT_AI_REFRESH_DEBOUNCE_MS = 5000;

/**
 * Shared "absent = default, present-but-invalid = fatal" reader for the
 * two AI env vars whose shape is a non-negative integer — mirrors
 * `readLogLevel`'s exact fail-fast style (`process.stderr.write` then
 * `process.exit(1)`) for the invalid case.
 */
function readPositiveIntegerEnv(variableName: string, defaultValue: number): number {
  const rawValue = process.env[variableName];

  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }

  const trimmedValue = rawValue.trim();

  if (!/^\d+$/.test(trimmedValue)) {
    process.stderr.write(
      `FATAL: ${variableName} environment variable has an invalid value "${rawValue}".\n`,
    );
    process.exit(1);
  }

  return Number.parseInt(trimmedValue, 10);
}

export const env: Env = readEnv();
