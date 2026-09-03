import { describe, expect, it } from 'vitest';

import { AgentConcurrencyGuard } from './agent-concurrency-guard.js';

/**
 * F3-T1 PR3 (RED step), ADR-0035 Karar (g) — `AgentConcurrencyGuard`: the
 * process-local, in-memory "how many actions is this agent running right
 * now" concurrency cap. Deliberately NO Postgres/Testcontainers here (this is
 * the in-memory half of Karar (g), unlike the DB-backed rate-limit half
 * covered by `./agent-resource-limits.service.integration.test.ts`) — a
 * plain, synchronous `Map<string, number>`-backed guard.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./agent-concurrency-guard.ts` does not exist
 * at all, so the static `import { AgentConcurrencyGuard } from
 * './agent-concurrency-guard.js'` above fails module resolution, failing
 * every `it` in this file — mirrors `packages/agent-runtime`'s own PR1 RED
 * test files' static-import convention (no DB/env transitive dependency here,
 * so a dynamic import isn't needed, unlike the `.integration.test.ts` files
 * in this directory).
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   export class AgentConcurrencyGuard {
 *     constructor(private readonly maxConcurrentPerAgent: number) {}
 *     acquire(key: string): boolean;
 *     release(key: string): void;
 *   }
 *
 * `key` is caller-constructed as `${workspaceId}:${agentIdentifier}` (this
 * class itself is agnostic to that shape — it just treats `key` as an opaque
 * string) — `acquire` returns `false` (without incrementing) when the given
 * key is ALREADY at `maxConcurrentPerAgent`, `true` (incrementing) otherwise.
 * `release` decrements, never goes below 0, and releasing a key that was
 * never acquired (or is already at 0) is a silent no-op — never throws.
 * ============================================================================
 */
describe('F3-T1 PR3 (RED step): AgentConcurrencyGuard — process-local, in-memory concurrency cap', () => {
  it('a key under the cap can acquire repeatedly up to maxConcurrentPerAgent, all returning true', () => {
    const guard = new AgentConcurrencyGuard(3);
    const key = 'workspace-1:summarizer-agent';

    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(true);
  });

  it('the (maxConcurrentPerAgent + 1)th acquire for the SAME key returns false', () => {
    const guard = new AgentConcurrencyGuard(2);
    const key = 'workspace-1:summarizer-agent';

    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(false);
  });

  it('a rejected (false) acquire attempt does NOT itself increment the counter -- a subsequent release does not push the count negative or corrupt later acquires', () => {
    const guard = new AgentConcurrencyGuard(1);
    const key = 'workspace-1:summarizer-agent';

    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(false);

    guard.release(key);
    // Exactly one slot should be free again -- if the rejected `acquire`
    // above had incorrectly incremented the counter, this would still
    // return `false`.
    expect(guard.acquire(key)).toBe(true);
  });

  it('DIFFERENT keys have fully independent counters: a second key is unaffected by the first key being at capacity', () => {
    const guard = new AgentConcurrencyGuard(1);
    const keyA = 'workspace-1:agent-a';
    const keyB = 'workspace-1:agent-b';

    expect(guard.acquire(keyA)).toBe(true);
    expect(guard.acquire(keyA)).toBe(false);

    // keyB has never been touched -- it must still have its own fresh slot.
    expect(guard.acquire(keyB)).toBe(true);
    expect(guard.acquire(keyB)).toBe(false);
  });

  it('release frees up a slot: after release, a subsequent acquire for that key returns true again', () => {
    const guard = new AgentConcurrencyGuard(1);
    const key = 'workspace-1:summarizer-agent';

    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(false);

    guard.release(key);

    expect(guard.acquire(key)).toBe(true);
  });

  it('releasing a key that was never acquired (count 0) does not throw and does not make the counter negative', () => {
    const guard = new AgentConcurrencyGuard(1);
    const neverAcquiredKey = 'workspace-1:never-acquired-agent';

    expect(() => {
      guard.release(neverAcquiredKey);
    }).not.toThrow();

    // If `release` had gone negative, a single subsequent acquire would
    // have to be rejected before the cap is genuinely reached; assert the
    // full cap is still available from a clean, zeroed state.
    expect(guard.acquire(neverAcquiredKey)).toBe(true);
  });

  it('releasing a key beyond its actual acquired count (over-release) clamps at 0 rather than going negative', () => {
    const guard = new AgentConcurrencyGuard(1);
    const key = 'workspace-1:summarizer-agent';

    expect(guard.acquire(key)).toBe(true);

    guard.release(key);
    guard.release(key); // one more release than was ever acquired
    guard.release(key);

    // Still only ONE slot should be grantable -- an over-release must not
    // have pushed the internal counter to a negative number that would
    // silently grant extra concurrent slots beyond the cap.
    expect(guard.acquire(key)).toBe(true);
    expect(guard.acquire(key)).toBe(false);
  });

  it('multiple acquire/release cycles interleaved correctly track the count', () => {
    const guard = new AgentConcurrencyGuard(2);
    const key = 'workspace-1:summarizer-agent';

    expect(guard.acquire(key)).toBe(true); // count 1
    expect(guard.acquire(key)).toBe(true); // count 2 (at cap)
    expect(guard.acquire(key)).toBe(false); // rejected, still count 2

    guard.release(key); // count 1
    expect(guard.acquire(key)).toBe(true); // count 2 (at cap again)
    expect(guard.acquire(key)).toBe(false); // rejected

    guard.release(key); // count 1
    guard.release(key); // count 0
    expect(guard.acquire(key)).toBe(true); // count 1
    expect(guard.acquire(key)).toBe(true); // count 2 (at cap)
    expect(guard.acquire(key)).toBe(false); // rejected
  });
});
