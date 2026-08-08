import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchIndexEmbeddingScheduler } from './search-index-embedding-scheduler.service.js';

/**
 * F1-T13 PR4 (RED step) — `SearchIndexEmbeddingScheduler`: a pure,
 * framework-adjacent (NestJS `Logger` only — no DB/HTTP) in-process debounce
 * scheduler for recomputing `search_index.embedding` after a title/doc-content
 * change (ADR-0013 §(e)).
 *
 * This is the STRUCTURAL twin of `../ai/ai-refresh-scheduler.service.ts`'s
 * `AIRefreshScheduler` (per task instructions, that file is the EXACT template
 * to mirror) — same `Map<string, NodeJS.Timeout>`-keyed debounce, same
 * `runSafely`/`logFailure` swallow-and-log discipline for a throwing/rejecting
 * `refreshFn`, same STATIC (non-interpolated) log message + `error.stack`
 * only, never content/user data (CLAUDE.md: "Kullanıcı verisini ... log'a
 * yazma"). The ONE deliberate difference: `AIRefreshScheduler.schedule(objectId,
 * fieldKey, refreshFn)` is keyed by `` `${objectId}:${fieldKey}` `` (per-field);
 * `SearchIndexEmbeddingScheduler.schedule(objectId, refreshFn)` is keyed by
 * `objectId` ALONE — there is exactly ONE search-embedding concept per object,
 * not per-field.
 *
 * `./search-index-embedding-scheduler.service.ts` does not exist yet, so every
 * `it` below fails at import time (module not found) — the correct RED state.
 *
 * ============================================================================
 * CONTRACT PINNED HERE (implementer must match exactly):
 *
 *   export class SearchIndexEmbeddingScheduler {
 *     constructor(delayMs?: number); // default 5000
 *     schedule(objectId: string, refreshFn: () => void | Promise<void>): void;
 *   }
 *
 * - `schedule(objectId, refreshFn)` starts a timer that, after `delayMs`,
 *   invokes `refreshFn()`.
 * - Calling `schedule` AGAIN for the SAME `objectId` BEFORE that timer fires
 *   CANCELS the previous timer and restarts the full delay window (debounce
 *   semantics) — only the LAST `schedule()` call's `refreshFn` closure ever
 *   actually runs, and it runs EXACTLY ONCE, not once per `schedule()` call.
 * - Calling `schedule` for DIFFERENT `objectId`s are completely independent
 *   timers — both eventually fire, on their own schedules.
 * - If `refreshFn` throws synchronously, or its returned promise rejects,
 *   this must NEVER crash/propagate out of the scheduler's internal timer
 *   callback, and must NEVER prevent any OTHER scheduled timer (past or
 *   future, for a different `objectId`) from firing normally.
 *
 * We use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(...)` (the exact
 * style already established by `../ai/ai-refresh-scheduler.service.test.ts`)
 * to assert timing deterministically, without any real wall-clock wait.
 * ============================================================================
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchIndexEmbeddingScheduler — construction defaults', () => {
  it('defaults delayMs to 5000ms when constructed with no argument', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler();
    const fn = vi.fn();

    scheduler.schedule('obj-1', fn);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SearchIndexEmbeddingScheduler — basic debounce timing', () => {
  it('does not call refreshFn before delayMs has elapsed, and calls it exactly once after', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(1_000);
    const fn = vi.fn();

    scheduler.schedule('obj-1', fn);

    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports an async refreshFn, and awaits/settles it without throwing', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(500);
    const fn = vi.fn(async () => {
      await Promise.resolve();
    });

    scheduler.schedule('obj-1', fn);

    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SearchIndexEmbeddingScheduler — same objectId debounces (restarts the delay)', () => {
  it('scheduling again for the SAME objectId before the timer fires cancels and restarts the delay — refreshFn called exactly once, not once per schedule() call', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(1_000);
    const fn = vi.fn();

    scheduler.schedule('obj-1', fn);
    await vi.advanceTimersByTimeAsync(600);
    expect(fn).not.toHaveBeenCalled();

    // Restarts the 1000ms window from t=600.
    scheduler.schedule('obj-1', fn);

    // Total elapsed since the FIRST schedule() call is now 1000ms (600 + 400)
    // -- past the ORIGINAL window's own delay -- but only 400ms since the
    // RESTART, so it must still not have fired. This is what actually proves
    // "restart", not merely "fires once".
    await vi.advanceTimersByTimeAsync(400);
    expect(fn).not.toHaveBeenCalled();

    // Now 1000ms have elapsed since the restart.
    await vi.advanceTimersByTimeAsync(600);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('many rapid schedule() calls for the same objectId collapse into exactly ONE refreshFn call', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(200);
    const fn = vi.fn();

    scheduler.schedule('obj-1', fn);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule('obj-1', fn);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule('obj-1', fn);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule('obj-1', fn);

    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('only the LAST-scheduled refreshFn for an objectId actually fires (an earlier closure for the same objectId never runs)', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(200);
    const firstFn = vi.fn();
    const secondFn = vi.fn();

    scheduler.schedule('obj-1', firstFn);
    await vi.advanceTimersByTimeAsync(100);
    scheduler.schedule('obj-1', secondFn);

    await vi.advanceTimersByTimeAsync(200);

    expect(firstFn).not.toHaveBeenCalled();
    expect(secondFn).toHaveBeenCalledTimes(1);
  });
});

describe('SearchIndexEmbeddingScheduler — independent objectIds', () => {
  it('different objectIds get independent timers -- both eventually fire, on their own schedules', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(500);
    const fnA = vi.fn();
    const fnB = vi.fn();

    scheduler.schedule('obj-1', fnA);
    await vi.advanceTimersByTimeAsync(300);
    scheduler.schedule('obj-2', fnB);

    // obj-1's own 500ms window closes now (300 + 200); obj-2's has only had
    // 200ms of its own 500ms window.
    await vi.advanceTimersByTimeAsync(200);
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});

describe('SearchIndexEmbeddingScheduler — a failing refreshFn never crashes the scheduler', () => {
  it('a refreshFn that throws SYNCHRONOUSLY when invoked does not propagate/throw out of schedule(), and a later unrelated schedule() call still fires normally', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(100);
    const throwingFn = vi.fn(() => {
      throw new Error('boom: synchronous embedding refresh failure');
    });

    expect(() => {
      scheduler.schedule('obj-1', throwingFn);
    }).not.toThrow();

    await vi.advanceTimersByTimeAsync(150);
    expect(throwingFn).toHaveBeenCalledTimes(1);

    const normalFn = vi.fn();
    scheduler.schedule('obj-2', normalFn);
    await vi.advanceTimersByTimeAsync(150);
    expect(normalFn).toHaveBeenCalledTimes(1);
  });

  it('a refreshFn whose returned promise REJECTS does not propagate/throw, produces no unhandled rejection, and a later unrelated schedule() call still fires normally', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(100);
    const rejectingFn = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('boom: asynchronous embedding refresh rejection');
    });

    scheduler.schedule('obj-1', rejectingFn);

    await vi.advanceTimersByTimeAsync(150);
    expect(rejectingFn).toHaveBeenCalledTimes(1);

    const normalFn = vi.fn();
    scheduler.schedule('obj-2', normalFn);
    await vi.advanceTimersByTimeAsync(150);
    expect(normalFn).toHaveBeenCalledTimes(1);
  });

  it('a failure for one objectId does not affect a DIFFERENT objectId already pending at the same time', async () => {
    vi.useFakeTimers();
    const scheduler = new SearchIndexEmbeddingScheduler(200);
    const rejectingFn = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('boom: this one always fails');
    });
    const normalFn = vi.fn();

    scheduler.schedule('obj-1', rejectingFn);
    scheduler.schedule('obj-2', normalFn);

    await vi.advanceTimersByTimeAsync(200);

    expect(rejectingFn).toHaveBeenCalledTimes(1);
    expect(normalFn).toHaveBeenCalledTimes(1);
  });
});
