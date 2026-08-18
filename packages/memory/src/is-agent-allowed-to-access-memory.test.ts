import { describe, expect, it } from 'vitest';

import { isAgentAllowedToAccessMemory } from './is-agent-allowed-to-access-memory.js';

import type { MemoryAccessPolicy } from './memory-access-policy.js';

/**
 * F2-T8 (RED step) — `isAgentAllowedToAccessMemory`, the pure fail-closed
 * evaluation function, per ADR-0024 Karar (l)
 * (`docs/adr/ADR-0024-bellek-kullanim-politikasi.md`).
 *
 * Pinned signature (implementer must match exactly — a SINGLE
 * `MemoryAccessPolicy | undefined` parameter, NOT a list + identifier; see
 * ADR-0024 §l's rationale, tied to the `(workspaceId, userId,
 * agentIdentifier)` unique-index guaranteeing at most one row per triple):
 *
 *   export function isAgentAllowedToAccessMemory(
 *     policy: MemoryAccessPolicy | undefined,
 *   ): boolean;
 *
 * Truth table (ADR-0024 Karar e/f/l, Kabul Kriteri 4):
 *   - `undefined` (no grant row exists)              -> false (fail-closed)
 *   - a policy with `revokedAt === null`              -> true
 *   - a policy with `revokedAt` set (a past Date)      -> false
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/memory/src/is-agent-allowed-to-access-memory.ts` (and its
 * sibling `packages/memory/src/memory-access-policy.ts`, the
 * `MemoryAccessPolicy` interface this file's fixtures are typed against).
 */

function buildPolicy(overrides: Partial<MemoryAccessPolicy> = {}): MemoryAccessPolicy {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    agentIdentifier: 'answer-question',
    grantedAt: new Date('2026-01-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

describe('isAgentAllowedToAccessMemory', () => {
  it('returns false when no policy row exists (policy === undefined) — fail-closed default (ADR-0024 Karar e)', () => {
    expect(isAgentAllowedToAccessMemory(undefined)).toBe(false);
  });

  it('returns true for a defined, non-revoked policy (revokedAt === null)', () => {
    const policy = buildPolicy({ revokedAt: null });

    expect(isAgentAllowedToAccessMemory(policy)).toBe(true);
  });

  it('returns false for a defined, revoked policy (revokedAt is a past Date)', () => {
    const policy = buildPolicy({ revokedAt: new Date('2026-02-01T00:00:00.000Z') });

    expect(isAgentAllowedToAccessMemory(policy)).toBe(false);
  });
});
