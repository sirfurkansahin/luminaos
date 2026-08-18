/**
 * `MemoryAccessPolicy` — a per-(workspace, user, agentIdentifier) grant/revoke
 * row, per ADR-0024 Karar (f)/(h). The record's mere EXISTENCE with
 * `revokedAt === null` means "allowed"; there is no separate `access`
 * enum — mirrors `desktop-signal-consents`'s grant/revoke shape exactly
 * (ADR-0020 Karar a), NOT a two-value allow/deny model.
 */
export interface MemoryAccessPolicy {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  grantedAt: Date;
  revokedAt: Date | null;
}
