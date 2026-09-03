import type { AgentPermissionManifest } from './agent-permission-manifest.js';

/**
 * Pure, fail-closed evaluator for whether a manifest grants a requested
 * action, per ADR-0035 Karar (c) and the spec's Kabul Kriterleri. Mirrors
 * `packages/memory`'s `isAgentAllowedToAccessMemory` fail-closed discipline
 * (`!policy -> false`, `revokedAt !== null -> false`), extended to 3
 * dimensions.
 *
 * Time-window boundaries are inclusive (`request.now === startsAt` or
 * `request.now === expiresAt` both pass) — achieved by using strict
 * `<`/`>` comparisons only for the failure conditions.
 */
export function evaluateManifestGrant(
  manifest: AgentPermissionManifest | undefined,
  request: { actionType: string; objectType?: string; now: Date },
): boolean {
  if (manifest === undefined) {
    return false;
  }

  if (manifest.revokedAt !== null) {
    return false;
  }

  if (!manifest.actionTypes.includes(request.actionType)) {
    return false;
  }

  if (
    request.objectType !== undefined &&
    manifest.dataScope.objectTypes !== 'all' &&
    !manifest.dataScope.objectTypes.includes(request.objectType)
  ) {
    return false;
  }

  const { startsAt, expiresAt } = manifest.timeWindow;

  if (startsAt !== null && request.now < startsAt) {
    return false;
  }

  if (expiresAt !== null && request.now > expiresAt) {
    return false;
  }

  return true;
}
