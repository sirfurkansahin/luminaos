/**
 * The safety-critical, exception-never-escapes runtime boundary, per
 * ADR-0035 Karar (a). Catches synchronous throws, rejected promises, AND
 * never-resolving promises (raced against a timeout) alike — the caller
 * NEVER sees a rejection/exception, only a structured `AgentActionResult`.
 */
export type AgentActionResult<T> =
  | { outcome: 'success'; value: T }
  | { outcome: 'timeout' }
  | { outcome: 'failure'; error: unknown };

export async function runInAgentSandbox<T>(
  fn: () => Promise<T>,
  options: { timeoutMs: number },
): Promise<AgentActionResult<T>> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ outcome: 'timeout' }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ outcome: 'timeout' });
    }, options.timeoutMs);
  });

  // The IIFE below is itself an async function: calling `fn()` -- even a
  // synchronous throw before it ever constructs a promise -- happens
  // inside this function's own try block, so a synchronous throw and a
  // rejected promise are both converted into a resolved `AgentActionResult`
  // here; nothing can escape as a rejection of `fnPromise`.
  const fnPromise = (async (): Promise<AgentActionResult<T>> => {
    try {
      const value = await fn();
      return { outcome: 'success', value };
    } catch (error) {
      return { outcome: 'failure', error };
    }
  })();

  try {
    return await Promise.race([fnPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
