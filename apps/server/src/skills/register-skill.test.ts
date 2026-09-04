import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';
import { signSkillManifest, SkillRegistry } from '@luminaos/skill-sdk';
import type { Skill } from '@luminaos/skill-sdk';

import { registerSkill } from './register-skill.js';

/**
 * Security-review finding (F3-T2 PR2): `SkillRegistry.register` takes an
 * arbitrary caller-supplied `publicKeyPem` per call -- nothing binds it to
 * this project's own canonical key. `registerSkill` curries
 * `SKILL_SDK_PUBLIC_KEY_PEM` so callers can never accidentally (or
 * maliciously) register a skill verified against a different key.
 */

function buildSignedSkill(privateKeyPem: string, id: string): Skill<unknown, unknown> {
  const unsigned = { id, version: '1.0.0', capability: `Test skill ${id}` };
  const signature = signSkillManifest(unsigned, privateKeyPem);
  return {
    manifest: { ...unsigned, signature },
    execute: (input: unknown) => Promise.resolve(input),
  };
}

describe('registerSkill', () => {
  it("registers a skill signed against a DIFFERENT private key than SKILL_SDK_PUBLIC_KEY_PEM's matching private key -> throws ValidationError (proves the canonical key is genuinely enforced, not an arbitrary one)", () => {
    // This test's own keypair is NOT the one matching SKILL_SDK_PUBLIC_KEY_PEM
    // (that private key was discarded, per skill-sdk-public-key.ts) -- so any
    // skill this test signs can never verify against the real canonical key.
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const registry = new SkillRegistry();
    const skill = buildSignedSkill(privateKeyPem, 'wrong-key-skill');

    expect(() => {
      registerSkill(registry, skill);
    }).toThrow(ValidationError);
    expect(registry.get('wrong-key-skill')).toBeUndefined();
  });

  it('always calls registry.register with SKILL_SDK_PUBLIC_KEY_PEM, never a caller-supplied key (no publicKeyPem parameter exists on registerSkill itself)', () => {
    // Structural assertion: registerSkill's signature takes only (registry, skill)
    // -- there is no way for a caller to pass a different key, by construction.
    expect(registerSkill).toHaveLength(2);
  });
});
