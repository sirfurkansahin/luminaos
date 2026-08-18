import type { MemoryAccessPolicy } from './memory-access-policy.js';

/**
 * Fail-closed evaluation, per ADR-0024 Karar (e)/(f)/(l): a `policy` of
 * `undefined` (no grant row exists for this (user, agentIdentifier) pair)
 * or a policy with a non-null `revokedAt` (grant was withdrawn) both
 * evaluate to `false`. Only an EXISTING, non-revoked policy is `true`.
 */
export function isAgentAllowedToAccessMemory(policy: MemoryAccessPolicy | undefined): boolean {
  if (!policy) {
    return false;
  }

  return policy.revokedAt === null;
}
