import { describe, expect, it } from 'vitest';

import { canonicalizeManifestForSigning } from './canonicalize-manifest.js';

/**
 * F3-T2 PR1 (RED step) — `canonicalizeManifestForSigning`, the single
 * shared serialization function used by BOTH the signer and the verifier,
 * per ADR-0036 Karar (c) (mirrors F2-T16's webhook delivery signing lesson:
 * the exact same shared `JSON.stringify` call is used for what is signed
 * and what is transmitted, for the exact same reason — canonicalization
 * drift is a signature-mismatch bug class this codebase already prevented
 * once):
 *
 *   export function canonicalizeManifestForSigning(
 *     manifest: Omit<SkillManifest, 'signature'>,
 *   ): string;
 *
 * MUST be deterministic regardless of the input object's own key insertion
 * order — the same logical manifest ({id, version, capability} values)
 * must always canonicalize to the identical string, or signing/verifying
 * would silently break for reasons unrelated to actual tampering.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/skill-sdk/src/canonicalize-manifest.ts` — this package
 * (`@luminaos/skill-sdk`) does not exist yet at all, so this import fails
 * with "Cannot find module", mirroring the RED-state convention
 * `packages/agent-runtime`'s own PR1 test files used.
 */

describe('canonicalizeManifestForSigning — key-order independence', () => {
  it('produces the identical string for two objects with the same logical values but keys declared in a different order', () => {
    const inOrderA = {
      id: 'create-object',
      version: '1.0.0',
      capability: 'Creates a new object within the agent-granted dataScope.',
    };
    const inOrderB = {
      capability: 'Creates a new object within the agent-granted dataScope.',
      version: '1.0.0',
      id: 'create-object',
    };

    expect(canonicalizeManifestForSigning(inOrderA)).toBe(canonicalizeManifestForSigning(inOrderB));
  });
});

describe('canonicalizeManifestForSigning — field sensitivity', () => {
  const base = {
    id: 'create-object',
    version: '1.0.0',
    capability: 'Creates a new object within the agent-granted dataScope.',
  };

  it('produces a different string when id differs', () => {
    expect(canonicalizeManifestForSigning(base)).not.toBe(
      canonicalizeManifestForSigning({ ...base, id: 'get-object' }),
    );
  });

  it('produces a different string when version differs', () => {
    expect(canonicalizeManifestForSigning(base)).not.toBe(
      canonicalizeManifestForSigning({ ...base, version: '2.0.0' }),
    );
  });

  it('produces a different string when capability differs', () => {
    expect(canonicalizeManifestForSigning(base)).not.toBe(
      canonicalizeManifestForSigning({ ...base, capability: 'Reads an object.' }),
    );
  });
});

describe('canonicalizeManifestForSigning — purity', () => {
  it('returns the same output for the same input when called twice', () => {
    const manifest = {
      id: 'query-objects',
      version: '1.2.3',
      capability: 'Queries objects visible within the agent-granted dataScope.',
    };

    expect(canonicalizeManifestForSigning(manifest)).toBe(canonicalizeManifestForSigning(manifest));
  });
});
