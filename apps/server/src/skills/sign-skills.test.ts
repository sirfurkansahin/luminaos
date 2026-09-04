import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

/**
 * F3-T2 PR2 (RED step), ADR-0036 Karar (b)/(c) -- `signManifestForSkill`, a
 * thin wrapper `apps/server/src/sign-skills.ts` (the future release/build-
 * time `sign-skills.ts` CLI script will call) that reuses `@luminaos/skill-
 * sdk`'s already-merged, already-exhaustively-tested `signSkillManifest`.
 * Deliberately minimal (2-3 cases) -- the underlying Ed25519 sign/verify
 * correctness itself is `packages/skill-sdk/src/sign-verify-skill-signature.
 * test.ts`'s job, already covered by PR1, not re-proven here.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./sign-skills.ts` does NOT exist yet, so the
 * dynamic `import('./sign-skills.js')` below rejects with "Cannot find
 * module" -- mirrors this PR's sibling `./skill-execution.service.
 * integration.test.ts`'s own documented RED-state convention.
 * `@luminaos/skill-sdk` (PR1, already merged, `dist/` already built) is a
 * genuine runtime dependency of this file (`verifySkillManifestSignature`,
 * used to independently verify the wrapper's own output) -- see that
 * sibling file's header for why `@luminaos/skill-sdk` is not yet a declared
 * dependency of `apps/server`'s `package.json` as of this commit
 * (implementer's job in this PR). Both `@luminaos/skill-sdk` and `./sign-
 * skills.js` are therefore imported dynamically (not statically) and their
 * exports explicitly, locally re-typed below -- exactly like that sibling
 * file's own convention -- so an unresolved package/module cannot cascade
 * into unrelated `no-unsafe-*` lint noise across this whole file.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   function signManifestForSkill(
 *     manifest: Omit<SkillManifest, 'signature'>,
 *     privateKeyPem: string,
 *   ): SkillManifest
 *
 * Returns the full manifest (`{...manifest, signature}`) with `signature`
 * populated via `@luminaos/skill-sdk`'s `signSkillManifest` -- no additional
 * logic of its own beyond assembling the returned object.
 * ============================================================================
 */

/**
 * A field-for-field local re-declaration of `@luminaos/skill-sdk`'s
 * `SkillManifest` -- kept local rather than imported, per this file's
 * header, so this file's own RED reason stays scoped to `./sign-skills.ts`
 * and `@luminaos/skill-sdk` not (yet) being a linked dependency, not an
 * incidental extra static-import surface.
 */
interface SkillManifestLike {
  id: string;
  version: string;
  capability: string;
  signature: string;
}

type SignManifestForSkillFn = (
  manifest: Omit<SkillManifestLike, 'signature'>,
  privateKeyPem: string,
) => SkillManifestLike;

type VerifySkillManifestSignatureFn = (
  manifest: SkillManifestLike,
  publicKeyPem: string,
) => boolean;

/** The SOLE dynamic-import call site for `./sign-skills.js` in this file. */
async function importSignManifestForSkill(): Promise<SignManifestForSkillFn> {
  const module: unknown = await import('./sign-skills.js');
  return (module as { signManifestForSkill: SignManifestForSkillFn }).signManifestForSkill;
}

/** The SOLE dynamic-import call site for `@luminaos/skill-sdk` in this file. */
async function importVerifySkillManifestSignature(): Promise<VerifySkillManifestSignatureFn> {
  const module: unknown = await import('@luminaos/skill-sdk');
  return (module as { verifySkillManifestSignature: VerifySkillManifestSignatureFn })
    .verifySkillManifestSignature;
}

function generateEd25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

describe('F3-T2 PR2 (RED step): signManifestForSkill', () => {
  it('1. round-trip: the returned manifest verifies successfully against the matching public key', async () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519Pem();
    const unsigned = {
      id: 'create-object',
      version: '1.0.0',
      capability: 'Creates a new object within the agent-granted dataScope.',
    };

    const signManifestForSkill = await importSignManifestForSkill();
    const verifySkillManifestSignature = await importVerifySkillManifestSignature();
    const manifest = signManifestForSkill(unsigned, privateKeyPem);

    expect(manifest.id).toBe(unsigned.id);
    expect(manifest.version).toBe(unsigned.version);
    expect(manifest.capability).toBe(unsigned.capability);
    expect(typeof manifest.signature).toBe('string');
    expect(manifest.signature.length).toBeGreaterThan(0);
    expect(verifySkillManifestSignature(manifest, publicKeyPem)).toBe(true);
  });

  it('2. tampering with a field AFTER signing (e.g. capability) makes verification fail', async () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519Pem();
    const unsigned = {
      id: 'get-object',
      version: '1.0.0',
      capability: 'Reads a single object by id.',
    };

    const signManifestForSkill = await importSignManifestForSkill();
    const verifySkillManifestSignature = await importVerifySkillManifestSignature();
    const manifest = signManifestForSkill(unsigned, privateKeyPem);
    const tampered: SkillManifestLike = { ...manifest, capability: 'Deletes every object.' };

    expect(verifySkillManifestSignature(tampered, publicKeyPem)).toBe(false);
  });

  it('3. verifying against a DIFFERENT (mismatched) public key fails, even with an untampered manifest', async () => {
    const { privateKeyPem } = generateEd25519Pem();
    const otherKeyPair = generateEd25519Pem();
    const unsigned = {
      id: 'query-objects',
      version: '1.0.0',
      capability: 'Runs a filtered query over objects.',
    };

    const signManifestForSkill = await importSignManifestForSkill();
    const verifySkillManifestSignature = await importVerifySkillManifestSignature();
    const manifest = signManifestForSkill(unsigned, privateKeyPem);

    expect(verifySkillManifestSignature(manifest, otherKeyPair.publicKeyPem)).toBe(false);
  });
});
