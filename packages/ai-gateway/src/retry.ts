/**
 * Retry policy per the spec (`docs/specs/F1-E1/F1-T5-ai-fields.md`):
 * "Hata/timeout/retry politikası (üstel geri çekilme, max 2 deneme)".
 */

export interface RetryOptions {
  /** Total number of attempts (not extra retries). Default: 2. */
  maxAttempts?: number;
  /** Base delay, in ms, for the exponential backoff. Default: 200. */
  baseDelayMs?: number;
  /** Whether a given error should trigger a retry. Default: retry everything. */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BASE_DELAY_MS = 200;

function defaultIsRetryable(): boolean {
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }
      // Exponential backoff: delay before attempt N+1 is baseDelayMs * 2^(N-1),
      // where N is the attempt number that just failed.
      await delay(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
