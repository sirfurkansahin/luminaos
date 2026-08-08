import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F1-T13 PR4 (RED step) — ONE new, optional-with-default env var:
 * `env.searchIndexEmbeddingDebounceMs`, sourced from
 * `SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS`.
 *
 * Follows `./env-ai.test.ts`'s / `./env-calendar.test.ts`'s EXACT precedent
 * (the established pattern for testing this module in isolation despite its
 * already-evaluated singleton export): `env.ts` has no dedicated test file
 * covering its ORIGINAL fields, only feature-scoped addenda files like this
 * one, each pinning ONE PR's new field(s) without touching `env.ts` or
 * weakening any existing test.
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
 * and mask the `SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS`-specific behavior this
 * file pins.
 *
 * `process.exit` is mocked to THROW a distinguishable `ProcessExitSignal`
 * instead of returning, mirroring `env-ai.test.ts`'s exact rationale: without
 * this, a plain no-op mock would let module evaluation fall through to the
 * next line with a missing value and produce a confusing, unrelated failure
 * instead of cleanly proving "this was fatal".
 *
 * ============================================================================
 * NEW CONTRACT PINNED HERE (implementer: extend `Env`/`readEnv()` in
 * `./env.ts` to match EXACTLY — mirrors `aiRefreshDebounceMs`'s/
 * `AI_REFRESH_DEBOUNCE_MS`'s "absent = default, present-but-invalid = fatal"
 * shape, reusing the existing `readPositiveIntegerEnv` helper verbatim):
 *
 *   interface Env {
 *     ...                                    // unchanged existing fields
 *     searchIndexEmbeddingDebounceMs: number; // NEW, always present (defaulted)
 *   }
 *
 * `SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS`:
 *   - absent, or blank/whitespace-only -> defaults to `5000` (milliseconds —
 *     matches `SearchIndexEmbeddingScheduler`'s OWN pure default, per
 *     `../search/search-index-embedding-scheduler.service.test.ts`'s pinned
 *     contract, so `new SearchIndexEmbeddingScheduler(env.searchIndexEmbeddingDebounceMs)`
 *     and `new SearchIndexEmbeddingScheduler()` behave identically in
 *     production when this env var is unset).
 *   - set to a valid non-negative integer string -> `env.searchIndexEmbeddingDebounceMs`
 *     equals that value AS A NUMBER, never the raw string.
 *   - set to a non-numeric string -> FATAL, `process.exit(1)`, the exact same
 *     fail-fast style as `LOG_LEVEL`'s / `AI_REFRESH_DEBOUNCE_MS`'s own
 *     invalid-value path (`process.stderr.write('FATAL: ...')` then
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

describe('env.ts — SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS (F1-T13 PR4, new field for SearchIndexEmbeddingScheduler wiring)', () => {
  it('defaults to 5000 (ms) when SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS is not set at all', async () => {
    delete process.env.SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS;

    const { env } = await import('./env.js');

    expect(env.searchIndexEmbeddingDebounceMs).toBe(5_000);
  });

  it('defaults to 5000 (ms) when SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS is blank/whitespace-only', async () => {
    process.env.SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS = '   ';

    const { env } = await import('./env.js');

    expect(env.searchIndexEmbeddingDebounceMs).toBe(5_000);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS = '50';

    const { env } = await import('./env.js');

    expect(env.searchIndexEmbeddingDebounceMs).toBe(50);
    expect(typeof env.searchIndexEmbeddingDebounceMs).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.SEARCH_INDEX_EMBEDDING_DEBOUNCE_MS = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
