import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { canonicalizeManifestForSigning } from './canonicalize-manifest.js';

import type { SkillManifest } from './skill-manifest.js';

/**
 * Signs a skill manifest (minus its `signature` field) with an Ed25519
 * private key — per ADR-0036 Karar (b)/(c). Ed25519 has no separate digest
 * step, so `algorithm` is `null` for both the one-shot `sign`/`verify`
 * Node APIs.
 */
export function signSkillManifest(
  manifest: Omit<SkillManifest, 'signature'>,
  privateKeyPem: string,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const data = Buffer.from(canonicalizeManifestForSigning(manifest), 'utf8');

  return sign(null, data, privateKey).toString('hex');
}

/**
 * Verifies a signed skill manifest against an Ed25519 public key — a
 * fail-closed, pure evaluator that NEVER throws, mirroring
 * `packages/agent-runtime`'s `evaluateManifestGrant` discipline (ADR-0035
 * §c). Any malformed input (bad PEM, bad hex, wrong-length signature,
 * mismatched key) resolves to `false`.
 */
export function verifySkillManifestSignature(
  manifest: SkillManifest,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const { signature, ...unsigned } = manifest;
    const data = Buffer.from(canonicalizeManifestForSigning(unsigned), 'utf8');
    const signatureBuffer = Buffer.from(signature, 'hex');

    return verify(null, data, publicKey, signatureBuffer);
  } catch {
    return false;
  }
}
