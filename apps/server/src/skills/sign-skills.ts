import { signSkillManifest } from '@luminaos/skill-sdk';
import type { SkillManifest } from '@luminaos/skill-sdk';

/**
 * F3-T2 PR2 (ADR-0036 Karar b/c): a thin wrapper around `@luminaos/skill-
 * sdk`'s `signSkillManifest`, reused by the future release/build-time
 * `sign-skills` script to sign real skill manifests. No logic of its own
 * beyond assembling the returned, fully-signed manifest.
 */
export function signManifestForSkill(
  manifest: Omit<SkillManifest, 'signature'>,
  privateKeyPem: string,
): SkillManifest {
  return { ...manifest, signature: signSkillManifest(manifest, privateKeyPem) };
}
