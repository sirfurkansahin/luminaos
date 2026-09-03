import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F3-T1 PR3 (RED step), ADR-0035 Karar (g) — FOUR new, all-optional,
 * all-defaulted env vars for the agent runtime's sandbox timeout /
 * concurrency cap / rate-limit resource limits, layered onto the EXISTING
 * (UNTOUCHED) `./env.ts`. Follows `./env-ai.test.ts`'s / `./env-search.test.ts`'s
 * EXACT precedent (the established pattern for testing this module in
 * isolation despite its already-evaluated singleton export): `env.ts` has no
 * test file of its own for its ORIGINAL fields, only feature-scoped addenda
 * files like this one, each pinning ONE PR's new field(s) without touching
 * `env.ts` or weakening any existing test.
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
 * and mask the agent-runtime-specific behavior this file pins.
 *
 * `process.exit` is mocked to THROW a distinguishable `ProcessExitSignal`
 * instead of returning, mirroring `env-ai.test.ts`'s exact rationale.
 *
 * ============================================================================
 * NEW CONTRACT PINNED HERE (implementer: extend `Env`/`readEnv()` in
 * `./env.ts` to match EXACTLY — all FOUR new fields reuse the EXISTING
 * `readPositiveIntegerEnv` helper verbatim, same "absent = default,
 * present-but-invalid = fatal" shape as `aiRefreshDebounceMs`/
 * `searchIndexEmbeddingDebounceMs`):
 *
 *   interface Env {
 *     ...                                          // unchanged existing fields
 *     agentSandboxTimeoutMs: number;                // NEW, always present (defaulted)
 *     agentSandboxMaxConcurrentPerAgent: number;     // NEW, always present (defaulted)
 *     agentActionRateLimitPerWindow: number;         // NEW, always present (defaulted)
 *     agentActionRateLimitWindowMs: number;          // NEW, always present (defaulted)
 *   }
 *
 * `AGENT_SANDBOX_TIMEOUT_MS`:
 *   - absent, or blank/whitespace-only -> defaults to `30000` (30 seconds).
 *   - set to a valid non-negative integer string -> `env.agentSandboxTimeoutMs`
 *     equals that value AS A NUMBER, never the raw string.
 *   - set to a non-numeric string -> FATAL, `process.exit(1)`.
 *
 * `AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT`:
 *   - absent, or blank/whitespace-only -> defaults to `3`.
 *   - set to a valid non-negative integer string -> `env.agentSandboxMaxConcurrentPerAgent`
 *     equals that value AS A NUMBER.
 *   - set to a non-numeric string -> FATAL, `process.exit(1)`.
 *
 * `AGENT_ACTION_RATE_LIMIT_PER_WINDOW`:
 *   - absent, or blank/whitespace-only -> defaults to `100`.
 *   - set to a valid non-negative integer string -> `env.agentActionRateLimitPerWindow`
 *     equals that value AS A NUMBER.
 *   - set to a non-numeric string -> FATAL, `process.exit(1)`.
 *
 * `AGENT_ACTION_RATE_LIMIT_WINDOW_MS`:
 *   - absent, or blank/whitespace-only -> defaults to `60000` (60 seconds).
 *   - set to a valid non-negative integer string -> `env.agentActionRateLimitWindowMs`
 *     equals that value AS A NUMBER.
 *   - set to a non-numeric string -> FATAL, `process.exit(1)`.
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

describe('env.ts — AGENT_SANDBOX_TIMEOUT_MS (F3-T1 PR3, ADR-0035 Karar g, new field for runInAgentSandbox wiring)', () => {
  it('defaults to 30000 (ms) when AGENT_SANDBOX_TIMEOUT_MS is not set at all', async () => {
    delete process.env.AGENT_SANDBOX_TIMEOUT_MS;

    const { env } = await import('./env.js');

    expect(env.agentSandboxTimeoutMs).toBe(30_000);
  });

  it('defaults to 30000 (ms) when AGENT_SANDBOX_TIMEOUT_MS is blank/whitespace-only', async () => {
    process.env.AGENT_SANDBOX_TIMEOUT_MS = '   ';

    const { env } = await import('./env.js');

    expect(env.agentSandboxTimeoutMs).toBe(30_000);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.AGENT_SANDBOX_TIMEOUT_MS = '150';

    const { env } = await import('./env.js');

    expect(env.agentSandboxTimeoutMs).toBe(150);
    expect(typeof env.agentSandboxTimeoutMs).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AGENT_SANDBOX_TIMEOUT_MS = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('env.ts — AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT (F3-T1 PR3, ADR-0035 Karar g, new field for AgentConcurrencyGuard wiring)', () => {
  it('defaults to 3 when AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT is not set at all', async () => {
    delete process.env.AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT;

    const { env } = await import('./env.js');

    expect(env.agentSandboxMaxConcurrentPerAgent).toBe(3);
  });

  it('defaults to 3 when AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT is blank/whitespace-only', async () => {
    process.env.AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = '   ';

    const { env } = await import('./env.js');

    expect(env.agentSandboxMaxConcurrentPerAgent).toBe(3);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = '5';

    const { env } = await import('./env.js');

    expect(env.agentSandboxMaxConcurrentPerAgent).toBe(5);
    expect(typeof env.agentSandboxMaxConcurrentPerAgent).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('env.ts — AGENT_ACTION_RATE_LIMIT_PER_WINDOW (F3-T1 PR3, ADR-0035 Karar g, new field for AgentResourceLimitsService wiring)', () => {
  it('defaults to 100 when AGENT_ACTION_RATE_LIMIT_PER_WINDOW is not set at all', async () => {
    delete process.env.AGENT_ACTION_RATE_LIMIT_PER_WINDOW;

    const { env } = await import('./env.js');

    expect(env.agentActionRateLimitPerWindow).toBe(100);
  });

  it('defaults to 100 when AGENT_ACTION_RATE_LIMIT_PER_WINDOW is blank/whitespace-only', async () => {
    process.env.AGENT_ACTION_RATE_LIMIT_PER_WINDOW = '   ';

    const { env } = await import('./env.js');

    expect(env.agentActionRateLimitPerWindow).toBe(100);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.AGENT_ACTION_RATE_LIMIT_PER_WINDOW = '3';

    const { env } = await import('./env.js');

    expect(env.agentActionRateLimitPerWindow).toBe(3);
    expect(typeof env.agentActionRateLimitPerWindow).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AGENT_ACTION_RATE_LIMIT_PER_WINDOW = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('env.ts — AGENT_ACTION_RATE_LIMIT_WINDOW_MS (F3-T1 PR3, ADR-0035 Karar g, new field for AgentResourceLimitsService wiring)', () => {
  it('defaults to 60000 (ms) when AGENT_ACTION_RATE_LIMIT_WINDOW_MS is not set at all', async () => {
    delete process.env.AGENT_ACTION_RATE_LIMIT_WINDOW_MS;

    const { env } = await import('./env.js');

    expect(env.agentActionRateLimitWindowMs).toBe(60_000);
  });

  it('defaults to 60000 (ms) when AGENT_ACTION_RATE_LIMIT_WINDOW_MS is blank/whitespace-only', async () => {
    process.env.AGENT_ACTION_RATE_LIMIT_WINDOW_MS = '   ';

    const { env } = await import('./env.js');

    expect(env.agentActionRateLimitWindowMs).toBe(60_000);
  });

  it('parses a valid non-negative integer string into a real number, not the raw string', async () => {
    process.env.AGENT_ACTION_RATE_LIMIT_WINDOW_MS = '1000';

    const { env } = await import('./env.js');

    expect(env.agentActionRateLimitWindowMs).toBe(1000);
    expect(typeof env.agentActionRateLimitWindowMs).toBe('number');
  });

  it('fails fast with process.exit(1) when set to a non-numeric value', async () => {
    process.env.AGENT_ACTION_RATE_LIMIT_WINDOW_MS = 'not-a-number';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(throwProcessExitSignal);

    await expect(import('./env.js')).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
