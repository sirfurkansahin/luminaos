import { generateKeyPairSync } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { signSkillManifest, verifySkillManifestSignature } from './sign-verify-skill-signature.js';

import type { SkillManifest } from './skill-manifest.js';

/**
 * F3-T2 PR1 (RED step) — `signSkillManifest`/`verifySkillManifestSignature`,
 * Ed25519 asymmetric signing over `canonicalizeManifestForSigning`'s output,
 * per ADR-0036 Karar (b)/(c):
 *
 *   export function signSkillManifest(
 *     manifest: Omit<SkillManifest, 'signature'>,
 *     privateKeyPem: string,
 *   ): string; // hex-encoded Ed25519 signature
 *
 *   export function verifySkillManifestSignature(
 *     manifest: SkillManifest,
 *     publicKeyPem: string,
 *   ): boolean; // NEVER throws — any malformed/mismatched input resolves to false
 *
 * `verifySkillManifestSignature` is a fail-closed, pure evaluator — mirrors
 * `packages/agent-runtime`'s `evaluateManifestGrant` fail-closed discipline
 * (ADR-0035 §c), extended here to asymmetric-signature verification: no
 * input shape, however malformed, may ever cause it to throw.
 *
 * Real Ed25519 keypairs (via Node's built-in `crypto.generateKeyPairSync`,
 * no new dependency — ADR-0036 Karar (b)) are generated once in `beforeAll`
 * and exported as PEM strings.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/skill-sdk/src/sign-verify-skill-signature.ts` (and its sibling
 * `packages/skill-sdk/src/canonicalize-manifest.ts`) — this package
 * (`@luminaos/skill-sdk`) does not exist yet at all, so this import fails
 * with "Cannot find module", mirroring the RED-state convention
 * `packages/agent-runtime`'s own PR1 test files used.
 */

let keyPairA: { privateKeyPem: string; publicKeyPem: string };
let keyPairB: { privateKeyPem: string; publicKeyPem: string };

function generateEd25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function buildUnsignedManifest(
  overrides: Partial<Omit<SkillManifest, 'signature'>> = {},
): Omit<SkillManifest, 'signature'> {
  return {
    id: 'create-object',
    version: '1.0.0',
    capability: 'Creates a new object within the agent-granted dataScope.',
    ...overrides,
  };
}

beforeAll(() => {
  keyPairA = generateEd25519Pem();
  keyPairB = generateEd25519Pem();
});

describe('signSkillManifest / verifySkillManifestSignature — round trip', () => {
  it('verifies true when signed with the private key and verified with the matching public key', () => {
    const unsigned = buildUnsignedManifest();
    const signature = signSkillManifest(unsigned, keyPairA.privateKeyPem);
    const manifest: SkillManifest = { ...unsigned, signature };

    expect(verifySkillManifestSignature(manifest, keyPairA.publicKeyPem)).toBe(true);
  });
});

describe('signSkillManifest / verifySkillManifestSignature — tamper detection', () => {
  it('returns false when a signed field is altered after signing but the signature is left unchanged', () => {
    const unsigned = buildUnsignedManifest();
    const signature = signSkillManifest(unsigned, keyPairA.privateKeyPem);
    const tampered: SkillManifest = {
      ...unsigned,
      capability: 'A completely different, tampered capability string.',
      signature,
    };

    expect(verifySkillManifestSignature(tampered, keyPairA.publicKeyPem)).toBe(false);
  });
});

describe('signSkillManifest / verifySkillManifestSignature — wrong key', () => {
  it('returns false when signed with keypair A private key but verified with keypair B public key', () => {
    const unsigned = buildUnsignedManifest();
    const signature = signSkillManifest(unsigned, keyPairA.privateKeyPem);
    const manifest: SkillManifest = { ...unsigned, signature };

    expect(verifySkillManifestSignature(manifest, keyPairB.publicKeyPem)).toBe(false);
  });
});

describe('signSkillManifest / verifySkillManifestSignature — malformed signature never throws', () => {
  it.each([
    ['non-hex garbage', 'not-hex-at-all!!'],
    ['empty string', ''],
    ['valid hex but wrong byte length for an Ed25519 signature', 'ab'],
  ])('returns false (never throws) when signature is %s', (_label, badSignature) => {
    const unsigned = buildUnsignedManifest();
    const manifest: SkillManifest = { ...unsigned, signature: badSignature };

    expect(() => verifySkillManifestSignature(manifest, keyPairA.publicKeyPem)).not.toThrow();
    expect(verifySkillManifestSignature(manifest, keyPairA.publicKeyPem)).toBe(false);
  });
});

describe('signSkillManifest / verifySkillManifestSignature — malformed public key PEM never throws', () => {
  it('returns false (never throws) when publicKeyPem is not a valid PEM at all', () => {
    const unsigned = buildUnsignedManifest();
    const signature = signSkillManifest(unsigned, keyPairA.privateKeyPem);
    const manifest: SkillManifest = { ...unsigned, signature };

    expect(() =>
      verifySkillManifestSignature(manifest, 'this-is-not-a-valid-pem-at-all'),
    ).not.toThrow();
    expect(verifySkillManifestSignature(manifest, 'this-is-not-a-valid-pem-at-all')).toBe(false);
  });
});
