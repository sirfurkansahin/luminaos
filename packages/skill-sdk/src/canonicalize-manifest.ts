import type { SkillManifest } from './skill-manifest.js';

/**
 * Produces the exact string that is signed/verified for a skill manifest —
 * per ADR-0036 Karar (c). Deliberately builds the string from an explicit,
 * fixed field order rather than relying on the input object's own key
 * order (which is exactly what F2-T16's webhook-signing precedent, and
 * this file's own tests, deliberately vary).
 */
export function canonicalizeManifestForSigning(manifest: Omit<SkillManifest, 'signature'>): string {
  return JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    capability: manifest.capability,
  });
}
