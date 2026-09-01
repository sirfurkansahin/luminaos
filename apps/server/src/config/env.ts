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
  /** Cumulative `SUM(cost_usd)` (a decimal dollar amount, not a token count) a workspace may reach across `ai_usage_records` before `refreshAIField` starts rejecting with `QuotaExceededError` (F1-T14 PR4), alongside the existing token-count quota. Absent/blank -> default; present-but-invalid (including negative) -> fatal. */
  aiCostBudgetUsdPerWorkspace: number;
  /** `AIRefreshScheduler`'s debounce window in milliseconds (F1-T5 PR-C). Absent/blank -> default (matches `AIRefreshScheduler`'s own pure default); present-but-invalid -> fatal. */
  aiRefreshDebounceMs: number;
  /** CORS allowlist origin for `apps/web` (F1-T7). Absent -> Vite's default dev origin; present -> used as-is, no shape validation (a malformed origin just fails every preflight, which is self-evident at request time). */
  webOrigin: string;
  /** CORS allowlist origin for `apps/desktop`'s Tauri webview (F2-T3 PR4, ADR-0020). Absent -> matches ADR-0019's `tauri.conf.json` `devUrl` (`http://localhost:1420`); present -> used as-is, no shape validation, mirrors `readWebOrigin()` exactly. */
  desktopOrigin: string;
  /** `DocCollabGateway`'s snapshot debounce window in milliseconds (F1-T11 PR4b): idle time after the last client edit before a room's `Y.Doc` is flushed to a `DocumentContentSnapshotted` event. Absent/blank -> default; present-but-invalid -> fatal. */
  docSnapshotDebounceMs: number;
  /** `DocCollabGateway`'s per-room accumulated-update threshold (F1-T11 PR4b): once this many client updates land since the last snapshot, the room is flushed immediately regardless of the debounce timer. Absent/blank -> default; present-but-invalid -> fatal. */
  docSnapshotMaxUpdates: number;
  /** `DocCollabGateway`'s DoS cap on concurrent connections to a single doc room (F1-T11 PR4b): upgrades beyond this for the same doc are rejected `503`. Absent/blank -> default; present-but-invalid -> fatal. */
  docMaxConnectionsPerRoom: number;
  /** `DocCollabGateway`'s DoS cap on the number of distinct live doc rooms (F1-T11 PR4b): an upgrade that would create a new room beyond this is rejected `503`. Absent/blank -> default; present-but-invalid -> fatal. */
  docMaxRooms: number;
  /** AES-256 key material for encrypting calendar-account OAuth tokens at rest (F1-T12 PR5a), base64-encoded in `ENCRYPTION_KEY`. Absent/blank -> `undefined` (the DI-layer signal `CalendarTokenEncryptionService` uses to throw `InvalidObjectStateError` lazily, at first use, rather than at boot); present-but-not-exactly-32-bytes-decoded -> fatal. */
  encryptionKey?: Buffer;
  /** `SearchIndexEmbeddingScheduler`'s debounce window in milliseconds (F1-T13 PR4, ADR-0013 §(e)). Absent/blank -> default (matches `SearchIndexEmbeddingScheduler`'s own pure default); present-but-invalid -> fatal. */
  searchIndexEmbeddingDebounceMs: number;
  /** The server's OWN public address (F2-T10 PR1, ADR-0026 §k) -- used to build the FIXED, workspace-independent MCP OAuth callback `redirect_uri` (`${serverPublicUrl}/integrations/:connectorType/oauth/callback`, ADR-0026 §j). Distinct from `webOrigin`/`desktopOrigin` (client-side CORS origins) -- this is the server's own address. Absent/blank -> `http://localhost:3000` (matches `main.ts`'s `app.listen(3000)` default); never fatal. */
  serverPublicUrl: string;
  /** `GOOGLE_DRIVE_CLIENT_ID`/`GOOGLE_DRIVE_CLIENT_SECRET` (F2-T10, ADR-0026 §k). Absent -> `undefined` (DI-layer signal to fall back to Mock, Karar l/m); PR2+ wires actual usage, PR1 only adds the reader shape. */
  googleDriveOAuth?: OAuthAppCredentials;
  /** `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` (F2-T10, ADR-0026 §k). Same absent/mismatched-pair semantics as `googleDriveOAuth`. */
  gmailOAuth?: OAuthAppCredentials;
  /** `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` (F2-T10, ADR-0026 §k). Same absent/mismatched-pair semantics as `googleDriveOAuth`. */
  slackOAuth?: OAuthAppCredentials;
  /** `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (F2-T10, ADR-0026 §k). Same absent/mismatched-pair semantics as `googleDriveOAuth`. */
  githubOAuth?: OAuthAppCredentials;
  /** `NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET` (F2-T10 PR1, ADR-0026 §k) -- the reference connector; PR1 actually WIRES this one into `McpConnectorsModule`'s DI factory (ADR-0026 §m). */
  notionOAuth?: OAuthAppCredentials;
  /** `NOTETAKER_WEBHOOK_SECRET` (F2-T13 PR4, ADR-0030 §f) -- HMAC-SHA256 shared secret `NotetakerWebhookAuthGuard` uses to verify `POST /webhooks/notetaker` requests. Absent/blank -> `undefined` (never fatal at boot — the DI-layer signal the guard uses to FAIL-CLOSED, rejecting every webhook request with 401, rather than crash boot). Any non-blank value is accepted as-is, verbatim, mirroring `readAnthropicApiKey` exactly. */
  notetakerWebhookSecret?: string;
}

/**
 * A configured OAuth application's client credentials (F2-T10, ADR-0026 §k)
 * -- one pair per MCP connector provider, application-level (not
 * workspace-level, ADR-0026 §f): a single LuminaOS deployment shares one
 * OAuth app per provider across all workspaces.
 */
export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
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
  const encryptionKey = readEncryptionKey();
  const googleDriveOAuth = readOAuthAppCredentials('GOOGLE_DRIVE');
  const gmailOAuth = readOAuthAppCredentials('GMAIL');
  const slackOAuth = readOAuthAppCredentials('SLACK');
  const githubOAuth = readOAuthAppCredentials('GITHUB');
  const notionOAuth = readOAuthAppCredentials('NOTION');
  const notetakerWebhookSecret = readNotetakerWebhookSecret();

  return {
    databaseUrl,
    logLevel: readLogLevel(),
    redisUrl,
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
    ...(encryptionKey !== undefined ? { encryptionKey } : {}),
    serverPublicUrl: readServerPublicUrl(),
    ...(googleDriveOAuth !== undefined ? { googleDriveOAuth } : {}),
    ...(gmailOAuth !== undefined ? { gmailOAuth } : {}),
    ...(slackOAuth !== undefined ? { slackOAuth } : {}),
    ...(githubOAuth !== undefined ? { githubOAuth } : {}),
    ...(notionOAuth !== undefined ? { notionOAuth } : {}),
    ...(notetakerWebhookSecret !== undefined ? { notetakerWebhookSecret } : {}),
    aiTokenQuotaPerWorkspace: readPositiveIntegerEnv(
      'AI_TOKEN_QUOTA_PER_WORKSPACE',
      DEFAULT_AI_TOKEN_QUOTA_PER_WORKSPACE,
    ),
    aiCostBudgetUsdPerWorkspace: readNonNegativeFloatEnv(
      'AI_COST_BUDGET_USD_PER_WORKSPACE',
      DEFAULT_AI_COST_BUDGET_USD_PER_WORKSPACE,
    ),
    aiRefreshDebounceMs: readPositiveIntegerEnv(
      'AI_REFRESH_DEBOUNCE_MS',
      DEFAULT_AI_REFRESH_DEBOUNCE_MS,
    ),
    webOrigin: readWebOrigin(),
    desktopOrigin: readDesktopOrigin(),
    docSnapshotDebounceMs: readPositiveIntegerEnv(
      'DOC_SNAPSHOT_DEBOUNCE_MS',
      DEFAULT_DOC_SNAPSHOT_DEBOUNCE_MS,
    ),
    docSnapshotMaxUpdates: readPositiveIntegerEnv(
      'DOC_SNAPSHOT_MAX_UPDATES',
      DEFAULT_DOC_SNAPSHOT_MAX_UPDATES,
    ),
    docMaxConnectionsPerRoom: readPositiveIntegerEnv(
      'DOC_MAX_CONNECTIONS_PER_ROOM',
      DEFAULT_DOC_MAX_CONNECTIONS_PER_ROOM,
    ),
    docMaxRooms: readPositiveIntegerEnv('DOC_MAX_ROOMS', DEFAULT_DOC_MAX_ROOMS),
    searchIndexEmbeddingDebounceMs: readPositiveIntegerEnv(
      'SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS',
      DEFAULT_SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS,
    ),
  };
}

/** `SERVER_PUBLIC_URL` (F2-T10 PR1, ADR-0026 §k): absent/blank -> `http://localhost:3000`, matching `main.ts`'s `app.listen(3000)` default -- never fatal, same "absence is not a misconfiguration" style as `readWebOrigin`. */
function readServerPublicUrl(): string {
  const rawServerPublicUrl = process.env['SERVER_PUBLIC_URL'];

  if (rawServerPublicUrl === undefined || rawServerPublicUrl.trim() === '') {
    return 'http://localhost:3000';
  }

  return rawServerPublicUrl;
}

/**
 * `${prefix}_CLIENT_ID`/`${prefix}_CLIENT_SECRET` (F2-T10, ADR-0026 §k):
 * BOTH absent/blank -> `undefined` (the DI-layer signal to fall back to
 * Mock/unregistered, Karar l/m). Only ONE present -> FATAL (a broken/half
 * configuration is a user error, never silently ignored) -- adapts
 * `readEncryptionKey`'s "present but wrong shape -> fatal" principle to this
 * pair-completeness shape. The values themselves are not shape-validated
 * (mirrors `readAnthropicApiKey`) -- an invalid client_id/secret is rejected
 * by the provider's own OAuth endpoint at call time.
 */
function readOAuthAppCredentials(prefix: string): OAuthAppCredentials | undefined {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const hasId = clientId !== undefined && clientId.trim() !== '';
  const hasSecret = clientSecret !== undefined && clientSecret.trim() !== '';

  if (!hasId && !hasSecret) {
    return undefined;
  }

  if (hasId !== hasSecret) {
    process.stderr.write(
      `FATAL: ${prefix}_CLIENT_ID/${prefix}_CLIENT_SECRET must both be set or both unset.\n`,
    );
    process.exit(1);
  }

  return { clientId: clientId as string, clientSecret: clientSecret as string };
}

/** `WEB_ORIGIN`: absent/blank -> Vite's default dev origin (`http://localhost:5173`), matching `readLogLevel`'s "absence is not a misconfiguration" style. */
function readWebOrigin(): string {
  const rawWebOrigin = process.env['WEB_ORIGIN'];

  if (rawWebOrigin === undefined || rawWebOrigin.trim() === '') {
    return 'http://localhost:5173';
  }

  return rawWebOrigin;
}

/** `DESKTOP_ORIGIN`: absent/blank -> `apps/desktop`'s Tauri dev-server origin (`http://localhost:1420`, matching ADR-0019's `tauri.conf.json` `devUrl`), same "absence is not a misconfiguration" style as `readWebOrigin`. */
function readDesktopOrigin(): string {
  const rawDesktopOrigin = process.env['DESKTOP_ORIGIN'];

  if (rawDesktopOrigin === undefined || rawDesktopOrigin.trim() === '') {
    return 'http://localhost:1420';
  }

  return rawDesktopOrigin;
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

/**
 * `NOTETAKER_WEBHOOK_SECRET` (F2-T13 PR4, ADR-0030 §f): absent/blank ->
 * `undefined` (never fatal — `NotetakerWebhookAuthGuard` fails closed, 401,
 * rather than crash boot). Any non-blank value is accepted as-is, verbatim,
 * with no shape validation — mirrors `readAnthropicApiKey` bit for bit.
 */
function readNotetakerWebhookSecret(): string | undefined {
  const rawSecret = process.env['NOTETAKER_WEBHOOK_SECRET'];

  if (rawSecret === undefined || rawSecret.trim() === '') {
    return undefined;
  }

  return rawSecret;
}

/**
 * `ENCRYPTION_KEY` (F1-T12 PR5a): absent/blank -> `undefined` (never fatal —
 * the DI-layer signal `CalendarTokenEncryptionService` uses to throw
 * `InvalidObjectStateError` lazily, at first use, rather than at boot; a
 * deployment without calendar features configured must not crash boot over
 * this). Present -> base64-decoded; the decoded buffer must be EXACTLY 32
 * bytes (AES-256 key length), otherwise this is a fatal misconfiguration,
 * mirroring `readPositiveIntegerEnv`'s present-but-invalid style exactly.
 */
function readEncryptionKey(): Buffer | undefined {
  const rawEncryptionKey = process.env['ENCRYPTION_KEY'];

  if (rawEncryptionKey === undefined || rawEncryptionKey.trim() === '') {
    return undefined;
  }

  const decodedKey = Buffer.from(rawEncryptionKey, 'base64');

  if (decodedKey.length !== 32) {
    process.stderr.write(
      'FATAL: ENCRYPTION_KEY environment variable has an invalid value: must base64-decode to exactly 32 bytes.\n',
    );
    process.exit(1);
  }

  return decodedKey;
}

/** `AI_TOKEN_QUOTA_PER_WORKSPACE`'s own default (F1-T5 PR-C design decision — one million total input+output tokens per workspace). */
const DEFAULT_AI_TOKEN_QUOTA_PER_WORKSPACE = 1_000_000;

/** `AI_COST_BUDGET_USD_PER_WORKSPACE`'s own default (F1-T14 PR4 design decision — a v1 placeholder of $10 per workspace). */
const DEFAULT_AI_COST_BUDGET_USD_PER_WORKSPACE = 10;

/** `AI_REFRESH_DEBOUNCE_MS`'s own default — matches `AIRefreshScheduler`'s pure default so `new AIRefreshScheduler(env.aiRefreshDebounceMs)` and `new AIRefreshScheduler()` behave identically when this env var is unset. */
const DEFAULT_AI_REFRESH_DEBOUNCE_MS = 5000;

/** `DOC_SNAPSHOT_DEBOUNCE_MS`'s own default (F1-T11 PR4b) — ADR-0011 §(c)'s "10 sn hareketsizlik" debounce window. */
const DEFAULT_DOC_SNAPSHOT_DEBOUNCE_MS = 10_000;

/** `DOC_SNAPSHOT_MAX_UPDATES`'s own default (F1-T11 PR4b) — the "art arda N update" ceiling that forces a snapshot before the debounce timer fires. */
const DEFAULT_DOC_SNAPSHOT_MAX_UPDATES = 100;

/** `DOC_MAX_CONNECTIONS_PER_ROOM`'s own default (F1-T11 PR4b) — per-room concurrent-connection DoS cap. */
const DEFAULT_DOC_MAX_CONNECTIONS_PER_ROOM = 50;

/** `DOC_MAX_ROOMS`'s own default (F1-T11 PR4b) — live-room-count DoS cap. */
const DEFAULT_DOC_MAX_ROOMS = 1000;

/** `SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS`'s own default (F1-T13 PR4) — matches `SearchIndexEmbeddingScheduler`'s pure default so `new SearchIndexEmbeddingScheduler(env.searchIndexEmbeddingDebounceMs)` and `new SearchIndexEmbeddingScheduler()` behave identically when this env var is unset. */
const DEFAULT_SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS = 5000;

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

/**
 * "Absent = default, present-but-invalid = fatal" reader for AI env vars
 * whose shape is a non-negative DECIMAL (e.g. a dollar cost budget) rather
 * than a non-negative integer — `readPositiveIntegerEnv`'s `^\d+$` regex is
 * integer-only and syntactically rejects both decimal points and a leading
 * `-`, so this reader parses with `Number.parseFloat` and explicitly rejects
 * `NaN` and negative values instead. Mirrors `readPositiveIntegerEnv`'s exact
 * fail-fast style (`process.stderr.write` then `process.exit(1)`) for the
 * invalid case. Zero is a valid (if extreme) value and is allowed through.
 */
function readNonNegativeFloatEnv(variableName: string, defaultValue: number): number {
  const rawValue = process.env[variableName];

  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }

  const trimmedValue = rawValue.trim();

  // Plain non-negative decimal only -- no leading `+`, no exponent notation,
  // no trailing garbage. Stricter than `Number.parseFloat` alone, which
  // would silently accept `'25.5abc'` as `25.5` and `'Infinity'` as a real
  // `Infinity` (which would then compare `>=` as always-false, silently
  // disabling the cost budget with no fatal error).
  if (!/^\d+(\.\d+)?$/.test(trimmedValue)) {
    process.stderr.write(
      `FATAL: ${variableName} environment variable has an invalid value "${rawValue}".\n`,
    );
    process.exit(1);
  }

  return Number.parseFloat(trimmedValue);
}

export const env: Env = readEnv();
