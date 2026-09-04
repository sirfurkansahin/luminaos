import { SkillRegistry } from '@luminaos/skill-sdk';
import type { Skill } from '@luminaos/skill-sdk';

import { SKILL_SDK_PUBLIC_KEY_PEM } from './skill-sdk-public-key.js';

/**
 * The ONLY sanctioned way to register a skill into a `SkillRegistry` in this
 * codebase (security-review finding, F3-T2 PR2): `SkillRegistry.register`
 * itself takes an arbitrary caller-supplied `publicKeyPem` per call, with
 * nothing binding it to this project's own canonical key -- a future PR
 * could accidentally (or a compromised skill package could deliberately)
 * pass a different key, bypassing signature verification against the
 * intended trust root. This wrapper curries `SKILL_SDK_PUBLIC_KEY_PEM` so
 * every real caller (PR3+) uses the canonical key, never an arbitrary one.
 */
export function registerSkill(registry: SkillRegistry, skill: Skill<unknown, unknown>): void {
  registry.register(skill, SKILL_SDK_PUBLIC_KEY_PEM);
}
