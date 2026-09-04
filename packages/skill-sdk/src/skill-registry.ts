import { ConflictError, ValidationError } from '@luminaos/shared';

import { verifySkillManifestSignature } from './sign-verify-skill-signature.js';
import { skillManifestSchema } from './skill-manifest.js';

import type { SkillManifest } from './skill-manifest.js';

/**
 * A single callable skill: its signed manifest plus its executable
 * implementation.
 */
export interface Skill<TInput, TOutput> {
  manifest: SkillManifest;
  execute(input: TInput): Promise<TOutput>;
}

/**
 * `Map`-based catalog of `Skill` instances, keyed by `manifest.id` —
 * mirrors `packages/integrations`'s `McpConnectorRegistry` in spirit (a
 * catalog, not an upsert), per ADR-0036 Karar (c)/(d).
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill<unknown, unknown>>();

  /**
   * Throws `ValidationError` if the manifest's signature does not verify
   * against `publicKeyPem`. Throws `ConflictError` if `manifest.id` is
   * already registered — re-registering the same id is almost always a
   * wiring bug, not an intended override.
   */
  register(skill: Skill<unknown, unknown>, publicKeyPem: string): void {
    const manifestResult = skillManifestSchema.safeParse(skill.manifest);

    if (!manifestResult.success) {
      throw new ValidationError('skill manifest failed shape validation', {
        issues: manifestResult.error.issues,
      });
    }

    if (!verifySkillManifestSignature(skill.manifest, publicKeyPem)) {
      throw new ValidationError('skill manifest signature failed verification', {
        id: skill.manifest.id,
      });
    }

    if (this.skills.has(skill.manifest.id)) {
      throw new ConflictError(`A skill is already registered for id "${skill.manifest.id}"`);
    }

    this.skills.set(skill.manifest.id, skill);
  }

  /** Returns `undefined` if not found — NOT throwing. */
  get(id: string): Skill<unknown, unknown> | undefined {
    return this.skills.get(id);
  }

  list(): SkillManifest[] {
    return Array.from(this.skills.values()).map((skill) => skill.manifest);
  }
}
