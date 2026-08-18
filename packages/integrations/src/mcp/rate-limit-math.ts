export interface RateLimitBucketState {
  /** Configured maximum tokens the bucket can ever hold (the "burst"
   * ceiling). */
  capacity: number;
  /** Tokens currently available, BEFORE this check's cost is deducted.
   * Always `0 <= tokensAvailable <= capacity`. */
  tokensAvailable: number;
  /** Tokens added back per millisecond (a fraction, e.g. capacity=60,
   * refillPerMs = 60 / 60_000 for "60 per minute"). */
  refillPerMs: number;
  /** Epoch-ms timestamp `tokensAvailable` was last refilled/observed
   * as-of. */
  lastRefillAtMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** The bucket state to PERSIST after this check — includes both the
   * refill-catch-up AND, if `allowed`, the cost deduction. Callers
   * persist this unconditionally (even when `allowed` is false, the
   * refill catch-up itself must still be saved, or a
   * denied-then-retried caller would re-pay for refill time already
   * elapsed). */
  nextState: RateLimitBucketState;
  /** Only present when `allowed` is false — milliseconds until
   * `cost` tokens would become available, for a `Retry-After`-style
   * caller hint. */
  retryAfterMs?: number;
}

/**
 * Pure token-bucket transition: refills `bucket` up to `capacity`
 * based on elapsed time since `lastRefillAtMs`, THEN attempts to
 * deduct `cost` tokens. No I/O, no `Date.now()` call internally — `now`
 * is an explicit parameter so this function is deterministic and
 * trivially unit-testable (mirrors this codebase's existing pure-math
 * convention of never reading wall-clock time inside a pure function).
 */
export function checkRateLimit(
  bucket: RateLimitBucketState,
  cost: number,
  nowMs: number,
): RateLimitCheckResult {
  const elapsedMs = nowMs - bucket.lastRefillAtMs;
  const refilledAmount = Math.min(
    bucket.capacity,
    bucket.tokensAvailable + elapsedMs * bucket.refillPerMs,
  );

  if (refilledAmount >= cost) {
    return {
      allowed: true,
      nextState: {
        ...bucket,
        tokensAvailable: refilledAmount - cost,
        lastRefillAtMs: nowMs,
      },
    };
  }

  const missingTokens = cost - refilledAmount;
  const retryAfterMs =
    bucket.refillPerMs > 0 ? missingTokens / bucket.refillPerMs : Number.POSITIVE_INFINITY;

  return {
    allowed: false,
    nextState: {
      ...bucket,
      tokensAvailable: refilledAmount,
      lastRefillAtMs: nowMs,
    },
    retryAfterMs,
  };
}
