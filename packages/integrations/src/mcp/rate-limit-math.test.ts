import { describe, expect, it } from 'vitest';

import { checkRateLimit } from './rate-limit-math.js';

import type { RateLimitBucketState } from './rate-limit-math.js';

/**
 * Designed contract (must be matched exactly by implementer — F2-T9 PR1,
 * red step; see ADR-0025 §h):
 *
 *   export interface RateLimitBucketState {
 *     capacity: number;
 *     tokensAvailable: number; // 0 <= tokensAvailable <= capacity
 *     refillPerMs: number;
 *     lastRefillAtMs: number;
 *   }
 *
 *   export interface RateLimitCheckResult {
 *     allowed: boolean;
 *     nextState: RateLimitBucketState; // ALWAYS present, even when allowed is false
 *     retryAfterMs?: number; // only present when allowed is false
 *   }
 *
 *   export function checkRateLimit(
 *     bucket: RateLimitBucketState,
 *     cost: number,
 *     nowMs: number,
 *   ): RateLimitCheckResult;
 *
 * Pure token-bucket transition: refills `bucket` up to `capacity` based on
 * elapsed time since `lastRefillAtMs`, THEN attempts to deduct `cost`
 * tokens. No I/O, no `Date.now()` internally — `nowMs` is always an explicit
 * parameter, so this function is deterministic and trivially unit-testable.
 * `nextState` must ALWAYS reflect refill catch-up, even on denial, so a
 * denied-then-retried caller does not re-pay for already-elapsed refill
 * time.
 */

function buildBucket(overrides: Partial<RateLimitBucketState> = {}): RateLimitBucketState {
  return {
    capacity: 60,
    tokensAvailable: 60,
    refillPerMs: 60 / 60_000, // 60 tokens per minute
    lastRefillAtMs: 0,
    ...overrides,
  };
}

describe('checkRateLimit — a fresh bucket at full capacity', () => {
  it('allows a request costing less than tokensAvailable', () => {
    const bucket = buildBucket({ tokensAvailable: 60, lastRefillAtMs: 1_000 });

    const result = checkRateLimit(bucket, 10, 1_000);

    expect(result.allowed).toBe(true);
  });

  it('reduces nextState.tokensAvailable by exactly cost', () => {
    const bucket = buildBucket({ tokensAvailable: 60, lastRefillAtMs: 1_000 });

    const result = checkRateLimit(bucket, 10, 1_000);

    expect(result.nextState.tokensAvailable).toBe(50);
  });

  it('updates nextState.lastRefillAtMs to nowMs', () => {
    const bucket = buildBucket({ tokensAvailable: 60, lastRefillAtMs: 1_000 });

    const result = checkRateLimit(bucket, 10, 1_000);

    expect(result.nextState.lastRefillAtMs).toBe(1_000);
  });

  it('does not include retryAfterMs when allowed', () => {
    const bucket = buildBucket({ tokensAvailable: 60, lastRefillAtMs: 1_000 });

    const result = checkRateLimit(bucket, 10, 1_000);

    expect(result.retryAfterMs).toBeUndefined();
  });
});

describe('checkRateLimit — a request costing more than tokensAvailable (even after refill)', () => {
  it('is denied (allowed: false)', () => {
    // capacity 60, refillPerMs = 1/1000 (1 token/sec), 5s elapsed => +5 tokens,
    // starting from 0 available => 5 available, cost 10 => still short.
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 0,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 0,
    });

    const result = checkRateLimit(bucket, 10, 5_000);

    expect(result.allowed).toBe(false);
  });

  it('still reflects the partial refill catch-up in nextState, without deducting cost', () => {
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 0,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 0,
    });

    const result = checkRateLimit(bucket, 10, 5_000);

    expect(result.nextState.tokensAvailable).toBe(5);
    expect(result.nextState.lastRefillAtMs).toBe(5_000);
  });

  it('includes a retryAfterMs representing time until enough tokens would be available', () => {
    // 5 available after refill, need 10 (5 more), refillPerMs = 1/1000 => 5000ms more needed.
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 0,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 0,
    });

    const result = checkRateLimit(bucket, 10, 5_000);

    expect(result.retryAfterMs).toBe(5_000);
  });
});

describe('checkRateLimit — refill is capped at capacity', () => {
  it('never refills above capacity, even after a very long elapsed gap', () => {
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 0,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 0,
    });

    // 10,000,000ms elapsed at 1 token/sec would be 10,000 tokens without the cap.
    const result = checkRateLimit(bucket, 1, 10_000_000);

    expect(result.allowed).toBe(true);
    expect(result.nextState.tokensAvailable).toBe(60 - 1);
  });

  it('caps nextState.tokensAvailable at capacity even on denial with a huge elapsed gap and an over-capacity cost', () => {
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 0,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 0,
    });

    const result = checkRateLimit(bucket, 61, 10_000_000);

    expect(result.allowed).toBe(false);
    expect(result.nextState.tokensAvailable).toBe(60);
  });
});

describe('checkRateLimit — zero elapsed time', () => {
  it('applies no refill when nowMs === lastRefillAtMs, only the cost deduction', () => {
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 20,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 5_000,
    });

    const result = checkRateLimit(bucket, 5, 5_000);

    expect(result.allowed).toBe(true);
    expect(result.nextState.tokensAvailable).toBe(15);
    expect(result.nextState.lastRefillAtMs).toBe(5_000);
  });

  it('applies no refill when nowMs === lastRefillAtMs and denies when cost exceeds tokensAvailable', () => {
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 3,
      refillPerMs: 1 / 1_000,
      lastRefillAtMs: 5_000,
    });

    const result = checkRateLimit(bucket, 5, 5_000);

    expect(result.allowed).toBe(false);
    expect(result.nextState.tokensAvailable).toBe(3);
  });
});

describe('checkRateLimit — cost exactly equal to tokensAvailable after refill', () => {
  it('is allowed and leaves resulting tokensAvailable at exactly 0', () => {
    const bucket = buildBucket({
      capacity: 60,
      tokensAvailable: 10,
      refillPerMs: 0,
      lastRefillAtMs: 0,
    });

    const result = checkRateLimit(bucket, 10, 0);

    expect(result.allowed).toBe(true);
    expect(result.nextState.tokensAvailable).toBe(0);
  });
});

describe('checkRateLimit — consecutive calls chaining nextState as the next bucket input', () => {
  it('supports burst then throttle then recovery across multiple sequential calls', () => {
    let bucket = buildBucket({
      capacity: 10,
      tokensAvailable: 10,
      refillPerMs: 1 / 1_000, // 1 token/sec
      lastRefillAtMs: 0,
    });

    // Burst: spend all 10 tokens at t=0.
    const first = checkRateLimit(bucket, 10, 0);
    expect(first.allowed).toBe(true);
    expect(first.nextState.tokensAvailable).toBe(0);
    bucket = first.nextState;

    // Throttle: immediately try again at t=0, nothing refilled yet.
    const second = checkRateLimit(bucket, 1, 0);
    expect(second.allowed).toBe(false);
    expect(second.nextState.tokensAvailable).toBe(0);
    bucket = second.nextState;

    // Recover: wait 3000ms (3 tokens refilled), request 2.
    const third = checkRateLimit(bucket, 2, 3_000);
    expect(third.allowed).toBe(true);
    expect(third.nextState.tokensAvailable).toBe(1);
    bucket = third.nextState;

    // Further recovery: wait another 5000ms (5 more tokens, capped at capacity 10),
    // 1 + 5 = 6 available, request 6 should exactly succeed.
    const fourth = checkRateLimit(bucket, 6, 8_000);
    expect(fourth.allowed).toBe(true);
    expect(fourth.nextState.tokensAvailable).toBe(0);
  });
});
