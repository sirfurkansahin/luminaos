import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIRefreshScheduler } from './ai-refresh-scheduler.service.js';

/**
 * F1-T5 PR-C (RED step) — `AIRefreshScheduler`: a pure, framework-adjacent
 * (NestJS `Logger` only — no DB/HTTP) debounce scheduler for the
 * `onSourceChange` AI-field refresh trigger. Per the approved plan
 * (`docs/specs/F1-E1/F1-T5-ai-fields.md`, Kapsam 4): "kaynak alan değişince
 * yenileme işi kuyruklanır (in-process job, debounce 5 sn)".
 *
 * `apps/server/src/objects/objects.service.ts`'s `recomputeFormulaFields` is
 * this task's DIRECT precedent for HOW a source-field change drives a
 * dependent field's recompute, but formula recompute is synchronous/pure and
 * folds into the SAME request cycle as `create`/`setFieldValues`. AI refresh
 * is a real async network call and cannot be folded in that way — it is
 * scheduled here, out-of-band, and fires later on its own timer. This file
 * only pins the SCHEDULER's own debounce semantics in isolation; the
 * `objects.service.ts` wiring that actually calls `schedule(...)` on a
 * source-field write is exercised end-to-end (real HTTP, real debounce
 * delay) by `../objects/object-ai-refresh.integration.test.ts`, not here.
 *
 * ============================================================================
 * CONTRACT PINNED HERE (implementer must match exactly — `./ai-refresh-scheduler.service.ts`
 * does not exist yet):
 *
 *   export class AIRefreshScheduler {
 *     constructor(delayMs?: number); // default 5000
 *     schedule(objectId: string, fieldKey: string, refreshFn: () => void | Promise<void>): void;
 *   }
 *
 * - `schedule(objectId, fieldKey, refreshFn)` starts a timer that, after
 *   `delayMs`, invokes `refreshFn()`.
 * - Calling `schedule` AGAIN for the SAME `(objectId, fieldKey)` pair BEFORE
 *   that timer fires CANCELS the previous timer and restarts the full delay
 *   window (debounce semantics) — only the LAST `schedule()` call within the
 *   window's `refreshFn` closure ever actually runs, and it runs EXACTLY
 *   ONCE, not once per `schedule()` call.
 * - Calling `schedule` for DIFFERENT `(objectId, fieldKey)` pairs are
 *   completely independent timers — both eventually fire, on their own
 *   schedules. This includes same `objectId` + different `fieldKey`, and
 *   different `objectId` + same `fieldKey` — the debounce KEY is the pair,
 *   not either half alone.
 * - If `refreshFn` throws synchronously, or its returned promise rejects,
 *   this must NEVER crash/propagate out of the scheduler's internal timer
 *   callback, and must NEVER prevent any OTHER scheduled timer (past or
 *   future) from firing normally. Mirrors
 *   `../event-store/event-bus.ts`'s `InProcessEventBus.logRejection` pattern:
 *   catch, log ONE generic message via NestJS's `Logger`, never the raw
 *   `error.message`/`error.stack` or any user/prompt data (CLAUDE.md:
 *   "Kullanıcı verisini ... log'a yazma").
 *
 * We use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(...)` (the exact
 * style already established by `packages/ai-gateway/src/retry.test.ts`) to
 * assert timing deterministically, without any real wall-clock wait.
 * ============================================================================
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('AIRefreshScheduler — construction defaults', () => {
  it('defaults delayMs to 5000ms when constructed with no argument', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler();
    const fn = vi.fn();

    scheduler.schedule('obj-1', 'summary', fn);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('AIRefreshScheduler — basic debounce timing', () => {
  it('does not call refreshFn before delayMs has elapsed, and calls it exactly once after', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(1_000);
    const fn = vi.fn();

    scheduler.schedule('obj-1', 'summary', fn);

    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports an async refreshFn, and awaits/settles it without throwing', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(500);
    const fn = vi.fn(async () => {
      await Promise.resolve();
    });

    scheduler.schedule('obj-1', 'summary', fn);

    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('AIRefreshScheduler — same (objectId, fieldKey) debounces (restarts the delay)', () => {
  it('scheduling again for the SAME pair before the timer fires cancels and restarts the delay — refreshFn called exactly once, not once per schedule() call', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(1_000);
    const fn = vi.fn();

    scheduler.schedule('obj-1', 'summary', fn);
    await vi.advanceTimersByTimeAsync(600);
    expect(fn).not.toHaveBeenCalled();

    // Restarts the 1000ms window from t=600.
    scheduler.schedule('obj-1', 'summary', fn);

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

  it('many rapid schedule() calls for the same pair collapse into exactly ONE refreshFn call', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(200);
    const fn = vi.fn();

    scheduler.schedule('obj-1', 'summary', fn);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule('obj-1', 'summary', fn);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule('obj-1', 'summary', fn);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule('obj-1', 'summary', fn);

    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('AIRefreshScheduler — independent (objectId, fieldKey) pairs', () => {
  it('different objectIds (same fieldKey) get independent timers -- both eventually fire, on their own schedules', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(500);
    const fnA = vi.fn();
    const fnB = vi.fn();

    scheduler.schedule('obj-1', 'summary', fnA);
    await vi.advanceTimersByTimeAsync(300);
    scheduler.schedule('obj-2', 'summary', fnB);

    // obj-1's own 500ms window closes now (300 + 200); obj-2's has only had
    // 200ms of its own 500ms window.
    await vi.advanceTimersByTimeAsync(200);
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('the same objectId with a DIFFERENT fieldKey is an independent timer too', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(500);
    const fnSummary = vi.fn();
    const fnPriority = vi.fn();

    scheduler.schedule('obj-1', 'summary', fnSummary);
    scheduler.schedule('obj-1', 'priority', fnPriority);

    await vi.advanceTimersByTimeAsync(500);
    expect(fnSummary).toHaveBeenCalledTimes(1);
    expect(fnPriority).toHaveBeenCalledTimes(1);
  });
});

describe('AIRefreshScheduler — a failing refreshFn never crashes the scheduler', () => {
  it('a refreshFn that throws SYNCHRONOUSLY when invoked does not propagate/throw out of schedule(), and a later unrelated schedule() call still fires normally', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(100);
    const throwingFn = vi.fn(() => {
      throw new Error('boom: synchronous refresh failure');
    });

    expect(() => {
      scheduler.schedule('obj-1', 'summary', throwingFn);
    }).not.toThrow();

    await vi.advanceTimersByTimeAsync(150);
    expect(throwingFn).toHaveBeenCalledTimes(1);

    const normalFn = vi.fn();
    scheduler.schedule('obj-2', 'other', normalFn);
    await vi.advanceTimersByTimeAsync(150);
    expect(normalFn).toHaveBeenCalledTimes(1);
  });

  it('a refreshFn whose returned promise REJECTS does not propagate/throw, produces no unhandled rejection, and a later unrelated schedule() call still fires normally', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(100);
    const rejectingFn = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('boom: asynchronous refresh rejection');
    });

    scheduler.schedule('obj-1', 'summary', rejectingFn);

    await vi.advanceTimersByTimeAsync(150);
    expect(rejectingFn).toHaveBeenCalledTimes(1);

    const normalFn = vi.fn();
    scheduler.schedule('obj-2', 'other', normalFn);
    await vi.advanceTimersByTimeAsync(150);
    expect(normalFn).toHaveBeenCalledTimes(1);
  });

  it('a failure for one (objectId, fieldKey) pair does not affect a DIFFERENT pair already pending at the same time', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRefreshScheduler(200);
    const rejectingFn = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('boom: this one always fails');
    });
    const normalFn = vi.fn();

    scheduler.schedule('obj-1', 'summary', rejectingFn);
    scheduler.schedule('obj-2', 'summary', normalFn);

    await vi.advanceTimersByTimeAsync(200);

    expect(rejectingFn).toHaveBeenCalledTimes(1);
    expect(normalFn).toHaveBeenCalledTimes(1);
  });
});
