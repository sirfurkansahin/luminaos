/**
 * F3-T14 PR1 (ADR-0048 §b): pure, DB-less state-machine helpers for
 * `FederationLink`. `packages/`-style constraint applies here too even
 * though this file lives under `apps/server` — no framework import, no DB
 * access, trivially unit-testable.
 */
export type FederationLinkStatus = 'pending' | 'active' | 'revoked';

/** An invalid transition returns `false` -- the caller (`FederationLinksService`)
 * throws `InvalidObjectStateError`, never this module. */
export function canTransition(from: FederationLinkStatus, to: FederationLinkStatus): boolean {
  if (from === 'pending' && to === 'active') return true;
  if ((from === 'pending' || from === 'active') && to === 'revoked') return true;
  return false;
}

/** Direction-independent pair identity: `[min(a,b), max(a,b)].join(':')`. */
export function computePairKey(workspaceIdA: string, workspaceIdB: string): string {
  return [workspaceIdA, workspaceIdB].sort().join(':');
}
