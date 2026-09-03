import { Injectable } from '@nestjs/common';

/**
 * F3-T1 PR3 (ADR-0035 Karar g): the process-local, in-memory half of the
 * agent runtime's resource limits -- "how many actions is this agent
 * running right now" -- backed by a plain `Map<string, number>` keyed by an
 * opaque, caller-constructed `key` (in practice `${workspaceId}:${agentIdentifier}`,
 * see `AgentResourceLimitsService`, but this class itself is agnostic to
 * that shape). Deliberately NOT DB-backed (unlike the rate-limit half,
 * `AgentResourceLimitsService.assertActionRateNotExceeded`) -- a concurrency
 * cap only needs to hold for the lifetime of this process, and a Postgres
 * round-trip per acquire/release would be pure overhead for a check this
 * cheap and this hot (once per sandboxed action, on both entry and exit).
 */
@Injectable()
export class AgentConcurrencyGuard {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxConcurrentPerAgent: number) {}

  /**
   * Returns `true` and increments `key`'s counter if it is currently below
   * `maxConcurrentPerAgent`; returns `false` WITHOUT incrementing otherwise.
   */
  acquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;

    if (current >= this.maxConcurrentPerAgent) {
      return false;
    }

    this.counts.set(key, current + 1);
    return true;
  }

  /**
   * Decrements `key`'s counter, clamped at 0 -- releasing a key that was
   * never acquired (or is already at 0) is a silent no-op, never throws.
   */
  release(key: string): void {
    const current = this.counts.get(key) ?? 0;

    if (current <= 0) {
      return;
    }

    this.counts.set(key, current - 1);
  }
}
