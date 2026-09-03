/**
 * v0 concrete types for the agent permission manifest, per ADR-0035 Karar
 * (c). Deliberately mirrors `packages/memory`'s `MemoryAccessPolicy` shape
 * but extends it from 2 dimensions to 3 (data scope x action type x time
 * window) — see ADR-0035 Karar (b)/(d) for why the natural key here is the
 * 2-part `(workspaceId, agentIdentifier)`, not `MemoryAccessPolicy`'s
 * 3-part key.
 */

/**
 * Deliberately NOT a closed union/enum — mirrors ADR-0024 §(a)'s
 * `agentIdentifier: string` rationale: F3-T2 (Skill SDK) will populate this
 * vocabulary later; locking a union today would carry the same
 * backwards-incompatibility risk ADR-0024 avoided.
 */
export type AgentActionType = string;

/**
 * `ObjectType[]` (@luminaos/core-objects) is deliberately NOT used here —
 * plain `string[]` keeps `packages/agent-runtime` independent of other
 * domain packages (CLAUDE.md: domain packages cannot import framework
 * code; `packages/automation` and `packages/memory` both depend only on
 * `@luminaos/shared`, this package preserves the same isolation).
 */
export interface AgentDataScope {
  objectTypes: string[] | 'all';
}

/**
 * A simple, bounded window — v0 has no recurring/cron-like scheduling; no
 * concrete recurrence need exists yet, so none is speculatively engineered
 * for F3-T2/F3-T3's hypothetical requirements.
 */
export interface AgentTimeWindow {
  startsAt: Date | null;
  expiresAt: Date | null;
}

export interface AgentPermissionManifest {
  id: string;
  workspaceId: string;
  agentIdentifier: string;
  dataScope: AgentDataScope;
  actionTypes: AgentActionType[];
  timeWindow: AgentTimeWindow;
  grantedAt: Date;
  revokedAt: Date | null;
}
