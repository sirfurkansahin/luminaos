import { afterEach, describe, expect, it, vi } from 'vitest';

import { withRetry } from './retry.js';

/**
 * Designed signatures (must be matched exactly by implementer — F1-T5 PR-A,
 * red step). Per the spec (`docs/specs/F1-E1/F1-T5-ai-fields.md`): "Hata/
 * timeout/retry politikası (üstel geri çekilme, max 2 deneme)".
 *
 *   export interface RetryOptions {
 *     maxAttempts?: number; // default 2 — TOTAL attempts, not extra retries
 *     baseDelayMs?: number; // default e.g. 200
 *     isRetryable?: (error: unknown) => boolean; // default: retry everything
 *   }
 *   export function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>
 *
 * Semantics pinned here:
 * - `maxAttempts` is the TOTAL number of attempts (default 2): call `fn()`;
 *   on rejection, wait `baseDelayMs * 2^(attemptNumber-1)` ms then call
 *   `fn()` once more; if that also rejects, the final rejection propagates.
 * - Success on the first attempt: `fn` called exactly once, no delay.
 * - `isRetryable(error) === false`: reject immediately with that error,
 *   without consuming a further attempt, even if attempts remain.
 * - `maxAttempts: 1`: no retry at all, `fn` called exactly once, any
 *   rejection propagates immediately.
 *
 * We use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(...)` (no
 * existing precedent for fake timers in this repo's `packages/*` test
 * suites, but `packages/ui/src/components/Toast/Toast.test.tsx` already
 * establishes the pattern for this repo generally) to assert the backoff
 * delay is real and exponential without a slow wall-clock test.
 */

afterEach(() => {
  vi.useRealTimers();
});

function countingFn(
  failuresBeforeSuccess: number,
  errorFactory: () => unknown = () => new Error('transient failure'),
) {
  let callCount = 0;
  const fn = vi.fn(async () => {
    await Promise.resolve();
    callCount += 1;
    if (callCount <= failuresBeforeSuccess) {
      throw errorFactory();
    }
    return `success-on-attempt-${String(callCount)}`;
  });
  return { fn, getCallCount: () => callCount };
}

describe('withRetry — success paths', () => {
  it('calls fn exactly once when it succeeds on the first attempt (no delay)', async () => {
    const { fn, getCallCount } = countingFn(0);

    const result = await withRetry(fn);

    expect(result).toBe('success-on-attempt-1');
    expect(getCallCount()).toBe(1);
  });

  it('retries once (2 total calls) and resolves when the first attempt fails but the second succeeds', async () => {
    vi.useFakeTimers();
    const { fn, getCallCount } = countingFn(1);

    const promise = withRetry(fn, { baseDelayMs: 200 });
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result).toBe('success-on-attempt-2');
    expect(getCallCount()).toBe(2);
  });
});

describe('withRetry — default maxAttempts is 2 (max 2 deneme)', () => {
  it('calls fn exactly 2 times (not more) when both attempts fail, and propagates the second attempt error', async () => {
    vi.useFakeTimers();
    const { fn, getCallCount } = countingFn(2, () => new Error('still failing'));

    const promise = withRetry(fn, { baseDelayMs: 200 });
    // Attach a rejection handler immediately so the fake-timer advance below
    // doesn't trigger an unhandled-rejection warning before we await it.
    const settled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).rejects.toThrow('still failing');
    await settled;
    expect(getCallCount()).toBe(2);
  });
});

describe('withRetry — exponential backoff delay', () => {
  it('does not call fn a second time before baseDelayMs has elapsed, and does call it after', async () => {
    vi.useFakeTimers();
    const { fn, getCallCount } = countingFn(1);

    const promise = withRetry(fn, { baseDelayMs: 200 });

    // Let the first (failing) attempt's microtasks settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(getCallCount()).toBe(1);

    // Not yet at the backoff delay: still only 1 call.
    await vi.advanceTimersByTimeAsync(100);
    expect(getCallCount()).toBe(1);

    // Past the exponential backoff delay (baseDelayMs * 2^0 = 200ms for the
    // first retry): the second attempt has now fired.
    await vi.advanceTimersByTimeAsync(150);
    expect(getCallCount()).toBe(2);

    await promise;
  });
});

describe('withRetry — isRetryable short-circuits retry', () => {
  it('does not retry when isRetryable returns false, rejecting immediately after exactly 1 call', async () => {
    const { fn, getCallCount } = countingFn(2, () => new Error('non-retryable failure'));

    await expect(withRetry(fn, { baseDelayMs: 200, isRetryable: () => false })).rejects.toThrow(
      'non-retryable failure',
    );

    expect(getCallCount()).toBe(1);
  });

  it('does retry when isRetryable returns true for the encountered error', async () => {
    vi.useFakeTimers();
    const { fn, getCallCount } = countingFn(1, () => new Error('retryable failure'));

    const promise = withRetry(fn, { baseDelayMs: 200, isRetryable: () => true });
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result).toBe('success-on-attempt-2');
    expect(getCallCount()).toBe(2);
  });
});

describe('withRetry — maxAttempts: 1 means no retry at all', () => {
  it('calls fn exactly once and propagates any failure immediately', async () => {
    const { fn, getCallCount } = countingFn(1, () => new Error('single-attempt failure'));

    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow('single-attempt failure');

    expect(getCallCount()).toBe(1);
  });
});
