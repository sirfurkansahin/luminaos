import { generateKeyPairSync } from 'node:crypto';

import { ConflictError, ValidationError } from '@luminaos/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { signSkillManifest } from './sign-verify-skill-signature.js';
import { SkillRegistry } from './skill-registry.js';

import type { Skill } from './skill-registry.js';
import type { SkillManifest } from './skill-manifest.js';

/**
 * F3-T2 PR1 (RED step) — `SkillRegistry`, per ADR-0036 Karar (c)/(d) and
 * the spec's Kabul Kriterleri — mirrors `packages/integrations`'s
 * `McpConnectorRegistry` in spirit (a catalog, NOT an upsert):
 *
 *   export interface Skill<TInput, TOutput> {
 *     manifest: SkillManifest;
 *     execute(input: TInput): Promise<TOutput>;
 *   }
 *
 *   export class SkillRegistry {
 *     register(skill: Skill<unknown, unknown>, publicKeyPem: string): void;
 *       // throws ValidationError if verifySkillManifestSignature(...) is false
 *       // throws ConflictError if manifest.id is already registered
 *     get(id: string): Skill<unknown, unknown> | undefined;
 *     list(): SkillManifest[];
 *   }
 *
 * Uses the same `crypto.generateKeyPairSync('ed25519')` + `signSkillManifest`
 * pattern as `sign-verify-skill-signature.test.ts` to construct real,
 * validly-signed test skills — this file legitimately depends on that
 * sibling module's exports existing, which is fine, both land in this PR.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/skill-sdk/src/skill-registry.ts` (and its siblings
 * `skill-manifest.ts`, `canonicalize-manifest.ts`,
 * `sign-verify-skill-signature.ts`) — this package (`@luminaos/skill-sdk`)
 * does not exist yet at all, so this import fails with "Cannot find module",
 * mirroring the RED-state convention `packages/agent-runtime`'s own PR1
 * test files used.
 */

let validKeyPair: { privateKeyPem: string; publicKeyPem: string };
let otherKeyPair: { privateKeyPem: string; publicKeyPem: string };

function generateEd25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function buildSignedSkill(
  privateKeyPem: string,
  overrides: Partial<Omit<SkillManifest, 'signature'>> = {},
): Skill<unknown, unknown> {
  const unsigned = {
    id: 'create-object',
    version: '1.0.0',
    capability: 'Creates a new object within the agent-granted dataScope.',
    ...overrides,
  };
  const signature = signSkillManifest(unsigned, privateKeyPem);

  return {
    manifest: { ...unsigned, signature },
    execute: async (input: unknown) => input,
  };
}

beforeAll(() => {
  validKeyPair = generateEd25519Pem();
  otherKeyPair = generateEd25519Pem();
});

describe('SkillRegistry — register with a valid signature', () => {
  it('succeeds without throwing, and get(id)/list() reflect the registered skill', () => {
    const registry = new SkillRegistry();
    const skill = buildSignedSkill(validKeyPair.privateKeyPem, { id: 'create-object' });

    expect(() => registry.register(skill, validKeyPair.publicKeyPem)).not.toThrow();
    expect(registry.get('create-object')).toBe(skill);
    expect(registry.list()).toContainEqual(skill.manifest);
  });
});

describe('SkillRegistry — register with an invalid signature', () => {
  it('throws ValidationError and does NOT add the skill to the registry', () => {
    const registry = new SkillRegistry();
    // Signed with keyPair A's private key, but registered against keyPair B's
    // (mismatched) public key -> signature verification must fail.
    const skill = buildSignedSkill(validKeyPair.privateKeyPem, { id: 'get-object' });

    expect(() => registry.register(skill, otherKeyPair.publicKeyPem)).toThrow(ValidationError);
    expect(registry.get('get-object')).toBeUndefined();
  });
});

describe('SkillRegistry — register with a manifest that fails shape validation', () => {
  it('throws ValidationError (not a signature error) and does NOT add the skill, even if a caller bypassed skillManifestSchema before constructing it', () => {
    const registry = new SkillRegistry();
    // An id over the schema's 100-char bound -- constructed (and signed) by
    // hand rather than via skillManifestSchema, simulating an unvalidated
    // caller. register() must enforce the schema itself, not rely on caller
    // discipline (this is what the fix for the security-review finding adds).
    const oversizedId = 'x'.repeat(101);
    const skill = buildSignedSkill(validKeyPair.privateKeyPem, { id: oversizedId });

    expect(() => registry.register(skill, validKeyPair.publicKeyPem)).toThrow(ValidationError);
    expect(registry.get(oversizedId)).toBeUndefined();
  });
});

describe('SkillRegistry — register with a duplicate id', () => {
  it('throws ConflictError on the second call and leaves the first registration retrievable, unmodified', () => {
    const registry = new SkillRegistry();
    const firstSkill = buildSignedSkill(validKeyPair.privateKeyPem, {
      id: 'query-objects',
      version: '1.0.0',
    });
    const secondSkill = buildSignedSkill(validKeyPair.privateKeyPem, {
      id: 'query-objects',
      version: '2.0.0',
    });

    registry.register(firstSkill, validKeyPair.publicKeyPem);

    expect(() => registry.register(secondSkill, validKeyPair.publicKeyPem)).toThrow(ConflictError);
    expect(registry.get('query-objects')).toBe(firstSkill);
    expect(registry.get('query-objects')?.manifest.version).toBe('1.0.0');
  });
});

describe('SkillRegistry — get for a never-registered id', () => {
  it('returns undefined, does not throw', () => {
    const registry = new SkillRegistry();

    expect(() => registry.get('never-registered')).not.toThrow();
    expect(registry.get('never-registered')).toBeUndefined();
  });
});

describe('SkillRegistry — list on a fresh registry', () => {
  it('returns an empty array', () => {
    const registry = new SkillRegistry();

    expect(registry.list()).toEqual([]);
  });
});

describe('SkillRegistry — list after registering multiple distinct skills', () => {
  it('returns all registered manifests (order-independent, count and content must match)', () => {
    const registry = new SkillRegistry();
    const skillOne = buildSignedSkill(validKeyPair.privateKeyPem, { id: 'create-object' });
    const skillTwo = buildSignedSkill(validKeyPair.privateKeyPem, { id: 'get-object' });
    const skillThree = buildSignedSkill(validKeyPair.privateKeyPem, { id: 'query-objects' });

    registry.register(skillOne, validKeyPair.publicKeyPem);
    registry.register(skillTwo, validKeyPair.publicKeyPem);
    registry.register(skillThree, validKeyPair.publicKeyPem);

    const manifests = registry.list();

    expect(manifests).toHaveLength(3);
    expect(manifests).toEqual(
      expect.arrayContaining([skillOne.manifest, skillTwo.manifest, skillThree.manifest]),
    );
  });
});
