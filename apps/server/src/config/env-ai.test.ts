import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F1-T5 PR-C (RED step) — THREE new, all-optional, all-defaulted env vars for
 * AI Fields, layered onto the EXISTING (UNTOUCHED) `./env.ts`. `env.ts` has
 * no test file of its own today (verified: only ad-hoc placeholder env-var
 * setup inside unrelated integration/unit test files, e.g.
 * `../common/app-error.filter.test.ts`'s "ENV NOTE" doc comment, which sets
 * `DATABASE_URL`/`REDIS_URL` just long enough to satisfy `env.ts`'s existing
 * boot-time check before testing something else entirely) — this is a NEW
 * file, per task instructions, and does not modify `env.ts` or any existing
 * test.
 *
 * Because `env.ts` exports an ALREADY-EVALUATED singleton
 * (`export const env: Env = readEnv();`), and `readEnv`/`readLogLevel` are
 * NOT exported, every test below:
 *   1. sets `process.env` values BEFORE importing,
 *   2. calls `vi.resetModules()` (in `beforeEach`) so the next
 *      `await import('./env.js')` re-evaluates the module fresh instead of
 *      returning a PREVIOUS test's already-frozen `env` object from Node's
 *      ESM module cache,
 *   3. restores `process.env` to its pre-suite snapshot afterward (`afterEach`)
 *      so mutated env vars never leak into any OTHER test file sharing this
 *      Vitest worker process — mirrors `../common/app-error.filter.test.ts`'s
 *      own `afterAll` restore convention for `DATABASE_URL`/`REDIS_URL`.
 *
 * `DATABASE_URL`/`REDIS_URL` are set to harmless placeholders (never actually
 * connected to) in every test purely so `readEnv()`'s EXISTING fail-fast
 * checks for those two don't themselves trip and mask the AI-specific
 * behavior this file actually pins.
 *
 * `process.exit` is REAL `process.exit` in production; spying/mocking it here
 * (rather than letting it actually terminate the test worker) is required to
 * assert the fail-fast path at all. It is mocked to THROW a distinguishable
 * `ProcessExitSignal` instead of returning — since `env.ts`'s fatal branches
 * do nothing after calling `process.exit(1)` (no following `return`, relying
 * on `process.exit`'s real "never returns" behavior), a plain
 * `mockImplementation(() => undefined)` would let module evaluation fall
 * through to the next line with a missing value and produce a confusing,
 * unrelated failure instead of cleanly proving "this was fatal". Throwing
 * lets `await expect(import(...)).rejects.toThrow(ProcessExitSignal)` assert
 * the fatal path precisely, the same way a real `process.exit` would abort
 * everything after it.
 *
 * ============================================================================
 * NEW CONTRACT PINNED HERE (implementer: extend `Env`/`readEnv()` in
 * `./env.ts` to match EXACTLY):
 *
 *   interface Env {
 *     ...                                  // unchanged existing fields
 *     anthropicApiKey?: string;            // NEW, optional
 *     aiTokenQuotaPerWorkspace: number;    // NEW, always present (defaulted)
 *     aiRefreshDebounceMs: number;         // NEW, always present (defaulted)
 *   }
 *
 * `ANTHROPIC_API_KEY`:
 *   - absent, OR blank/whitespace-only (mirrors `readLogLevel`'s existing
 *     "blank == absent" convention) -> `env.anthropicApiKey === undefined`,
 *     and the process boots fine (NO `process.exit`). This is the signal the
 *     REST of F1-T5's DI wiring (not this file's concern) uses to fall back
 *     to `MockProvider` instead of constructing a real `AnthropicProvider`.
 *   - set to any non-blank string -> `env.anthropicApiKey` equals that exact
 *     string, verbatim (no trimming/transformation of a non-blank value).
 *   - NEVER fatal: there is no "invalid" `ANTHROPIC_API_KEY` SHAPE from
 *     `env.ts`'s point of view -- any non-blank string is accepted as-is (the
 *     real Anthropic SDK, not `env.ts`, is what would eventually reject a
 *     malformed key, at CALL time, not boot time).
 *
 * `AI_TOKEN_QUOTA_PER_WORKSPACE` (mirrors `readLogLevel`'s EXACT
 * "absent = default, present-but-invalid = fatal" shape, per this task's
 * instructions):
 *   - absent, or blank/whitespace-only -> defaults to `1_000_000` (one
 *     million total input+output tokens per workspace -- this default VALUE
 *     is THIS test file's own design decision, chosen for round-number
 *     parity, not dictated by the spec; `architect`/`implementer` should feel
 *     free to challenge it later, but must match it here for this PR to go
 *     green).
 *   - set to a valid non-negative integer string (e.g. `'500000'`) ->
 *     `env.aiTokenQuotaPerWorkspace` equals that value AS A NUMBER (500000),
 *     never the raw string.
 *   - set to a non-numeric string (e.g. `'not-a-number'`) -> FATAL,
 *     `process.exit(1)`, the exact same fail-fast style as `LOG_LEVEL`'s own
 *     invalid-value path (`process.stderr.write('FATAL: ...')` then
 *     `process.exit(1)`).
 *
 * `AI_REFRESH_DEBOUNCE_MS` (NOT explicitly requested by this task's Part 2 --
 * PROPOSED here, by this test file, for `../ai/ai-refresh-scheduler.service.ts`'s
 * `AIRefreshScheduler` constructor's `delayMs` parameter, per Part 4's
 * integration test's own need to run the onSourceChange debounce window in a
 * few real milliseconds rather than the production default of 5 real
 * seconds -- see `../objects/object-ai-refresh.integration.test.ts`'s header
 * doc comment for the full reasoning. Pinned here, alongside the other two AI
 * env vars, for ONE canonical place `implementer` can read every AI-related
 * env var's contract from, and because its "absent = default,
 * present-but-invalid = fatal" shape is IDENTICAL to
 * `AI_TOKEN_QUOTA_PER_WORKSPACE`'s -- same rules apply verbatim):
 *   - absent, or blank/whitespace-only -> defaults to `5000` (milliseconds --
 *     matches `AIRefreshScheduler`'s OWN pure default, per
 *     `../ai/ai-refresh-scheduler.service.test.ts`'s pinned contract, so
 *     `new AIRefreshScheduler(env.aiRefreshDebounceMs)` and
 *     `new AIRefreshScheduler()` behave identically in production when this
 *     env var is unset).
 *   - set to a valid non-negative integer string -> `env.aiRefreshDebounceMs`
 *     equals that value as a number.
 *   - set to a non-numeric string -> FATAL, `process.exit(1)`, same style.
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
 * undefined` (Node's own `.d.ts`) -- `env.ts` only ever calls it with a
 * plain `1`, but `vi.spyOn(process, 'exit').mockImplementation(...)` requires
 * an implementation assignable to the WIDER real signature, not the narrower
 * `number | undefined` this suite actually cares about.
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

describe('env.ts — ANTHROPIC_API_KEY (F1-T5 PR-C, new optional field)', () => {
  it('is undefined, and the module loads without exiting, when ANTHROPIC_API_KEY is not set at all', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const { env } = await import('./env.js');

    expect(env.anthropicApiKey).toBeUndefined();
  });

  it('is undefined when ANTHROPIC_API_KEY is blank/whitespace-only (mirrors LOG_LEVEL\'s "blank == absent" convention)', async () => {
    process.env.ANTHROPIC_API_KEY = '   ';

    const { env } = await import('./env.js');

    expect(env.anthropicApiKey).toBeUndefined();
  });

  it('equals the exact configured string when ANTHROPIC_API_KEY is set to a non-blank value', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-placeholder-key';

    const { env } = await import('./env.js');

    expect(env.anthropicApiKey).toBe('sk-ant-unit-test-placeholder-key');
  });
});

describe('env.ts — AI_TOKEN_QUOTA_PER_WORKSPACE (F1-T5 PR-C, new field with a default)', () => {
  it('defaults to 1_000_000 when AI_TOKEN_QUOTA_PER_WORKSPACE is not set at all', async () => {
    delete process.env.AI_TOKEN_QUOTA_PER_WORKSPACE;

    const { env } = await import('./env.js');

    expect(env.aiTokenQuotaPerWorkspace).toBe(1_000_000);
  });

  it('defaults to 1_000_000 when AI_TOKEN_QUOTA_PER_WORKSPACE is blank/whitespace-only', async () => {
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '   ';

    const { env } = await import('./env.js');

    expect(env.aiTokenQuotaPerWorkspace).toBe(1_000_000);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '500000';

    const { env } = await import('./env.js');

    expect(env.aiTokenQuotaPerWorkspace).toBe(500_000);
    expect(typeof env.aiTokenQuotaPerWorkspace).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

/**
 * F1-T14 PR4 (RED step) — a NEW, always-present (defaulted) `Env` field,
 * `aiCostBudgetUsdPerWorkspace: number`, backed by a NEW `AI_COST_BUDGET_USD_PER_WORKSPACE`
 * env var, alongside the existing `aiTokenQuotaPerWorkspace` token-count
 * quota. Unlike every other AI env var pinned above (all read via the
 * existing `readPositiveIntegerEnv` helper, integer-only, regex `^\d+$`),
 * this one must accept DECIMAL/fractional values (`'25.5'`) since it
 * represents a fractional-dollar budget, not a token count — so it needs
 * its OWN reader, not `readPositiveIntegerEnv` reused as-is.
 *
 * NEW CONTRACT PINNED HERE (implementer: extend `Env`/`readEnv()` in
 * `./env.ts` to match):
 *
 *   interface Env {
 *     ...
 *     aiCostBudgetUsdPerWorkspace: number;  // NEW, always present (defaulted)
 *   }
 *
 * `AI_COST_BUDGET_USD_PER_WORKSPACE`:
 *   - absent, or blank/whitespace-only -> defaults to SOME documented
 *     placeholder number (this test file does not pin the exact default
 *     value — that is `implementer`'s own design decision to make and
 *     document in `env.ts`'s doc comment, mirroring every other default
 *     here — it only pins that the result IS a `number`, never `undefined`
 *     and never `NaN`).
 *   - set to a valid non-negative DECIMAL string (e.g. `'25.5'`) ->
 *     `env.aiCostBudgetUsdPerWorkspace` equals that value AS A NUMBER
 *     (`25.5`), never the raw string, and never rounded/truncated to an
 *     integer.
 *   - set to a non-numeric string (e.g. `'not-a-number'`) -> FATAL,
 *     `process.exit(1)`, same fail-fast style as every other AI env var
 *     above.
 *   - set to a NEGATIVE number string (e.g. `'-5'`) -> ALSO fatal. This is
 *     a validation rule `readPositiveIntegerEnv` does not need (its regex
 *     `^\d+$` already syntactically rejects a leading `-`), but a decimal
 *     reader that accepts fractional values must explicitly reject
 *     negative ones too, since a negative dollar budget is nonsensical.
 */
describe('env.ts — AI_COST_BUDGET_USD_PER_WORKSPACE (F1-T14 PR4, new decimal-valued field with a default)', () => {
  it('is a real, non-NaN number (some documented default) when AI_COST_BUDGET_USD_PER_WORKSPACE is not set at all', async () => {
    delete process.env.AI_COST_BUDGET_USD_PER_WORKSPACE;

    const { env } = await import('./env.js');

    expect(typeof env.aiCostBudgetUsdPerWorkspace).toBe('number');
    expect(Number.isNaN(env.aiCostBudgetUsdPerWorkspace)).toBe(false);
  });

  it('is a real, non-NaN number (some documented default) when AI_COST_BUDGET_USD_PER_WORKSPACE is blank/whitespace-only', async () => {
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '   ';

    const { env } = await import('./env.js');

    expect(typeof env.aiCostBudgetUsdPerWorkspace).toBe('number');
    expect(Number.isNaN(env.aiCostBudgetUsdPerWorkspace)).toBe(false);
  });

  it('parses a valid non-negative DECIMAL string into a real (non-truncated) number, not the raw string', async () => {
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '25.5';

    const { env } = await import('./env.js');

    expect(env.aiCostBudgetUsdPerWorkspace).toBe(25.5);
    expect(typeof env.aiCostBudgetUsdPerWorkspace).toBe('number');
  });

  it('parses a valid non-negative INTEGER string (no decimal point) into a real number too', async () => {
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '10';

    const { env } = await import('./env.js');

    expect(env.aiCostBudgetUsdPerWorkspace).toBe(10);
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails fast with process.exit(1) when set to a NEGATIVE number (a negative $ budget is nonsensical, unlike the token-count reader this does not reuse)', async () => {
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '-5';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('env.ts — AI_REFRESH_DEBOUNCE_MS (F1-T5 PR-C, proposed here for AIRefreshScheduler wiring)', () => {
  it('defaults to 5000 (ms) when AI_REFRESH_DEBOUNCE_MS is not set at all', async () => {
    delete process.env.AI_REFRESH_DEBOUNCE_MS;

    const { env } = await import('./env.js');

    expect(env.aiRefreshDebounceMs).toBe(5_000);
  });

  it('defaults to 5000 (ms) when AI_REFRESH_DEBOUNCE_MS is blank/whitespace-only', async () => {
    process.env.AI_REFRESH_DEBOUNCE_MS = '   ';

    const { env } = await import('./env.js');

    expect(env.aiRefreshDebounceMs).toBe(5_000);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.AI_REFRESH_DEBOUNCE_MS = '50';

    const { env } = await import('./env.js');

    expect(env.aiRefreshDebounceMs).toBe(50);
    expect(typeof env.aiRefreshDebounceMs).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AI_REFRESH_DEBOUNCE_MS = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
