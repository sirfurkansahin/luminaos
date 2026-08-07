import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F1-T12 PR5a (RED step) — ONE new, OPTIONAL env field on `./env.ts`:
 * `encryptionKey?: Buffer`, sourced from the `ENCRYPTION_KEY` env var.
 *
 * Follows `./env-ai.test.ts`'s EXACT precedent (the established pattern for
 * testing this module in isolation despite its already-evaluated singleton
 * export): `env.ts` has no dedicated test file covering its ORIGINAL fields
 * (`databaseUrl`/`logLevel`/`redisUrl`), only feature-scoped addenda files
 * like this one and `env-ai.test.ts`, each pinning ONE PR's new field(s)
 * without touching `env.ts` or weakening any existing test. This file adds
 * `ENCRYPTION_KEY` coverage the same way `env-ai.test.ts` added
 * `ANTHROPIC_API_KEY` coverage — a NEW file, `env.ts` untouched.
 *
 * Because `env.ts` exports an ALREADY-EVALUATED singleton
 * (`export const env: Env = readEnv();`), every test below:
 *   1. sets `process.env` values BEFORE importing,
 *   2. calls `vi.resetModules()` (in `beforeEach`) so the next
 *      `await import('./env.js')` re-evaluates the module fresh,
 *   3. restores `process.env` to its pre-suite snapshot afterward
 *      (`afterEach`) so mutated env vars never leak into another test file
 *      sharing this Vitest worker process.
 *
 * `DATABASE_URL`/`REDIS_URL` are set to harmless placeholders in every test
 * purely so `readEnv()`'s EXISTING fail-fast checks for those two don't trip
 * and mask the `ENCRYPTION_KEY`-specific behavior this file pins.
 *
 * `process.exit` is mocked to THROW a distinguishable `ProcessExitSignal`
 * instead of returning, mirroring `env-ai.test.ts`'s exact rationale: without
 * this, a plain no-op mock would let module evaluation fall through to the
 * next line with a missing value and produce a confusing, unrelated failure
 * instead of cleanly proving "this was fatal".
 *
 * ============================================================================
 * NEW CONTRACT PINNED HERE (implementer: extend `Env`/`readEnv()` in
 * `./env.ts` to match EXACTLY):
 *
 *   interface Env {
 *     ...                          // unchanged existing fields
 *     encryptionKey?: Buffer;      // NEW, optional — AES-256 key material
 *   }
 *
 *   function readEncryptionKey(): Buffer | undefined { ... }
 *
 * `ENCRYPTION_KEY`:
 *   - absent, OR blank/whitespace-only (mirrors `readAnthropicApiKey`'s
 *     "blank == absent" convention) -> `env.encryptionKey === undefined`,
 *     and the process boots fine (NO `process.exit`). A deployment without
 *     calendar features configured must not crash boot over this — this is
 *     the DI-layer signal `CalendarTokenEncryptionService` uses to throw
 *     `InvalidObjectStateError` lazily, at first USE, rather than at
 *     boot/import time (see `../calendar/calendar-token-encryption.service.ts`,
 *     not this file's concern).
 *   - set, and base64-decodes to EXACTLY 32 bytes (AES-256 key length) ->
 *     `env.encryptionKey` is a real `Buffer` instance of length 32, whose
 *     bytes equal the decoded value.
 *   - set, but base64-decodes to any length OTHER than 32 (too short, too
 *     long, or garbage that decodes to an empty/wrong-length buffer) ->
 *     FATAL, exact same fail-fast style as `readPositiveIntegerEnv`'s
 *     invalid-value path (`process.stderr.write('FATAL: ENCRYPTION_KEY
 *     environment variable has an invalid value...')` then
 *     `process.exit(1)`).
 * ============================================================================
 */

class ProcessExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${String(code)}) called`);
    this.name = 'ProcessExitSignal';
  }
}

/**
 * `process.exit`'s real signature accepts `string | number | null |
 * undefined` — `vi.spyOn(process, 'exit').mockImplementation(...)` requires
 * an implementation assignable to that wider real signature.
 */
function throwProcessExitSignal(code?: string | number | null): never {
  throw new ProcessExitSignal(typeof code === 'number' ? code : undefined);
}

const ENV_SNAPSHOT = { ...process.env };

function restoreEnvToSnapshot(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, ENV_SNAPSHOT);
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgres://unit-test-placeholder/db';
  process.env.REDIS_URL = 'redis://unit-test-placeholder:6379';
});

afterEach(() => {
  restoreEnvToSnapshot();
  vi.restoreAllMocks();
});

describe('env.ts — ENCRYPTION_KEY (F1-T12 PR5a, new optional field for calendar-account token encryption)', () => {
  it('is undefined, and the module loads without exiting, when ENCRYPTION_KEY is not set at all', async () => {
    delete process.env.ENCRYPTION_KEY;

    const { env } = await import('./env.js');

    expect(env.encryptionKey).toBeUndefined();
  });

  it('is undefined when ENCRYPTION_KEY is blank/whitespace-only (mirrors ANTHROPIC_API_KEY\'s "blank == absent" convention)', async () => {
    process.env.ENCRYPTION_KEY = '   ';

    const { env } = await import('./env.js');

    expect(env.encryptionKey).toBeUndefined();
  });

  it('is a real 32-byte Buffer, matching the decoded bytes, when ENCRYPTION_KEY base64-decodes to exactly 32 bytes', async () => {
    const rawKey = Buffer.alloc(32, 7);
    process.env.ENCRYPTION_KEY = rawKey.toString('base64');

    const { env } = await import('./env.js');

    const decodedKey = env.encryptionKey;
    expect(Buffer.isBuffer(decodedKey)).toBe(true);
    expect(decodedKey).toHaveLength(32);
    expect(decodedKey ? Buffer.compare(decodedKey, rawKey) : -1).toBe(0);
  });

  it('fails fast with process.exit(1) when ENCRYPTION_KEY base64-decodes to FEWER than 32 bytes', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails fast with process.exit(1) when ENCRYPTION_KEY base64-decodes to MORE than 32 bytes', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(48, 1).toString('base64');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails fast with process.exit(1) when ENCRYPTION_KEY is set to non-base64 garbage that decodes to the wrong length', async () => {
    process.env.ENCRYPTION_KEY = 'not-valid-base64-key-material!!!';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
