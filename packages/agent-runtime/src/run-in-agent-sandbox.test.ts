import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInAgentSandbox } from './run-in-agent-sandbox.js';

/**
 * F3-T1 PR1 (RED step) — `runInAgentSandbox`, the safety-critical
 * exception-never-escapes runtime boundary, per ADR-0035 Karar (a):
 *
 *   export type AgentActionResult<T> =
 *     | { outcome: 'success'; value: T }
 *     | { outcome: 'timeout' }
 *     | { outcome: 'failure'; error: unknown };
 *
 *   export async function runInAgentSandbox<T>(
 *     fn: () => Promise<T>,
 *     options: { timeoutMs: number },
 *   ): Promise<AgentActionResult<T>>;
 *
 * This is the ADR's authoritative shape (NOT any earlier plan draft that may
 * have included a `durationMs` field) — a plain 3-variant discriminated
 * union on `outcome`.
 *
 * Core safety guarantee under test: `runInAgentSandbox` NEVER rejects and
 * NEVER throws, regardless of whether `fn` throws synchronously, returns a
 * rejected promise, or returns a promise that never settles within
 * `options.timeoutMs` — every one of those is translated into a resolved,
 * structured `AgentActionResult`.
 *
 * Timeout is exercised with `vi.useFakeTimers()` +
 * `vi.advanceTimersByTimeAsync(...)` (established precedent in this repo,
 * see `packages/ai-gateway/src/retry.test.ts`), avoiding a slow wall-clock
 * test.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/run-in-agent-sandbox.ts`.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('runInAgentSandbox — success path', () => {
  it('returns { outcome: "success", value } when fn resolves normally', async () => {
    const result = await runInAgentSandbox(async () => 'resolved-value', { timeoutMs: 1000 });

    expect(result).toEqual({ outcome: 'success', value: 'resolved-value' });
  });

  it('resolves (never rejects) on the success path', async () => {
    await expect(runInAgentSandbox(async () => 42, { timeoutMs: 1000 })).resolves.toEqual({
      outcome: 'success',
      value: 42,
    });
  });
});

describe('runInAgentSandbox — synchronous throw', () => {
  // Typed as `() => Promise<T>` per the pinned signature, but the function
  // body throws BEFORE ever returning/constructing a promise — this is the
  // "fn throws synchronously" case the sandbox must still catch even though
  // the call site does not `await` before entering its try/catch.
  function throwsSynchronously(): Promise<string> {
    throw new Error('boom');
  }

  it('returns { outcome: "failure", error } when fn throws synchronously (before returning a promise)', async () => {
    const result = await runInAgentSandbox(throwsSynchronously, { timeoutMs: 1000 });

    expect(result.outcome).toBe('failure');
    expect(result).toMatchObject({ outcome: 'failure', error: expect.any(Error) });
    if (result.outcome === 'failure') {
      expect((result.error as Error).message).toBe('boom');
    }
  });

  it('the returned promise never rejects when fn throws synchronously', async () => {
    await expect(
      runInAgentSandbox(throwsSynchronously, { timeoutMs: 1000 }),
    ).resolves.not.toThrow();
  });
});

describe('runInAgentSandbox — rejected promise', () => {
  it('returns { outcome: "failure", error } when fn returns a promise that rejects', async () => {
    const rejection = new Error('async failure');
    const result = await runInAgentSandbox(
      async () => {
        throw rejection;
      },
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ outcome: 'failure', error: rejection });
  });

  it('the returned promise never rejects when fn returns a rejected promise', async () => {
    await expect(
      runInAgentSandbox(
        async () => {
          throw new Error('async failure');
        },
        { timeoutMs: 1000 },
      ),
    ).resolves.toMatchObject({ outcome: 'failure' });
  });
});

describe('runInAgentSandbox — timeout (never-resolving promise)', () => {
  it('returns { outcome: "timeout" } when fn never resolves within options.timeoutMs', async () => {
    vi.useFakeTimers();

    const neverResolves = () => new Promise<never>(() => {});
    const resultPromise = runInAgentSandbox(neverResolves, { timeoutMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({ outcome: 'timeout' });
  });

  it('the returned promise never rejects on timeout', async () => {
    vi.useFakeTimers();

    const neverResolves = () => new Promise<never>(() => {});
    const resultPromise = runInAgentSandbox(neverResolves, { timeoutMs: 500 });

    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.not.toThrow();
  });

  it('does not report a timeout when fn resolves comfortably before options.timeoutMs elapses', async () => {
    vi.useFakeTimers();

    const resultPromise = runInAgentSandbox(async () => 'fast-value', { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toEqual({ outcome: 'success', value: 'fast-value' });
  });
});

describe('runInAgentSandbox — core safety guarantee (regression canary)', () => {
  it.each([
    [
      'synchronous throw',
      (): Promise<never> => {
        throw new Error('sync');
      },
    ],
    [
      'rejected promise',
      async (): Promise<never> => {
        throw new Error('rejected');
      },
    ],
  ] as const)(
    'never rejects the outer promise regardless of how fn fails (%s)',
    async (_label, fn) => {
      await expect(runInAgentSandbox(fn, { timeoutMs: 1000 })).resolves.toBeDefined();
    },
  );
});
