import { ValidationError } from '@luminaos/shared';
import { describe, expect, it } from 'vitest';

import { assertValidSemver, skillManifestSchema } from './skill-manifest.js';

/**
 * F3-T2 PR1 (RED step) — `SkillManifest` type + `skillManifestSchema` +
 * `assertValidSemver`, per ADR-0036 Karar (b)/(c)/(d) and the spec's
 * Kabul Kriterleri:
 *
 *   export interface SkillManifest {
 *     id: string;
 *     version: string;
 *     capability: string;
 *     signature: string;
 *   }
 *   export const skillManifestSchema: ZodType<SkillManifest>; // .strict()
 *     // id: string, min 1, max 100
 *     // version: string, min 1, max 50
 *     // capability: string, min 1, max 500
 *     // signature: string, min 1
 *   export function assertValidSemver(version: string): void;
 *     // throws ValidationError (from @luminaos/shared) unless version is a
 *     // strict X.Y.Z (three dot-separated non-negative integers, no leading
 *     // zeros beyond a bare "0", no prerelease/build metadata suffix in v1)
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/skill-sdk/src/skill-manifest.ts` — this package (`@luminaos/skill-sdk`)
 * does not exist yet at all, so this import fails with "Cannot find module",
 * mirroring the RED-state convention `packages/agent-runtime`'s own PR1 test
 * files used (see `evaluate-manifest-grant.test.ts`/`run-in-agent-sandbox.test.ts`).
 */

function buildManifest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'create-object',
    version: '1.0.0',
    capability: 'Creates a new object within the agent-granted dataScope.',
    signature: 'a1b2c3',
    ...overrides,
  };
}

describe('skillManifestSchema', () => {
  it('accepts a well-formed manifest', () => {
    expect(skillManifestSchema.safeParse(buildManifest()).success).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = skillManifestSchema.safeParse(buildManifest({ extra: 'field' }));

    expect(result.success).toBe(false);
  });

  it('rejects a missing id', () => {
    const manifest = buildManifest();
    delete manifest.id;

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a non-string id', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ id: 123 })).success).toBe(false);
  });

  it('rejects an empty-string id', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ id: '' })).success).toBe(false);
  });

  it('rejects an id longer than 100 characters', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ id: 'x'.repeat(101) })).success).toBe(
      false,
    );
  });

  it('rejects a missing version', () => {
    const manifest = buildManifest();
    delete manifest.version;

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a non-string version', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ version: 100 })).success).toBe(false);
  });

  it('rejects an empty-string version', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ version: '' })).success).toBe(false);
  });

  it('rejects a version longer than 50 characters', () => {
    expect(
      skillManifestSchema.safeParse(buildManifest({ version: '1.' + '0'.repeat(60) })).success,
    ).toBe(false);
  });

  it('rejects a missing capability', () => {
    const manifest = buildManifest();
    delete manifest.capability;

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a non-string capability', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ capability: {} })).success).toBe(false);
  });

  it('rejects an empty-string capability', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ capability: '' })).success).toBe(false);
  });

  it('rejects a capability longer than 500 characters', () => {
    expect(
      skillManifestSchema.safeParse(buildManifest({ capability: 'x'.repeat(501) })).success,
    ).toBe(false);
  });

  it('rejects a missing signature', () => {
    const manifest = buildManifest();
    delete manifest.signature;

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a non-string signature', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ signature: 42 })).success).toBe(false);
  });

  it('rejects an empty-string signature', () => {
    expect(skillManifestSchema.safeParse(buildManifest({ signature: '' })).success).toBe(false);
  });
});

describe('assertValidSemver — valid versions (never throw)', () => {
  it.each([['1.0.0'], ['0.0.1'], ['12.34.56'], ['0.0.0'], ['999.999.999']])(
    'does not throw for "%s"',
    (version) => {
      expect(() => assertValidSemver(version)).not.toThrow();
    },
  );
});

describe('assertValidSemver — invalid versions (always throw ValidationError)', () => {
  it.each([
    [''],
    ['1.0'],
    ['1.0.0-beta'],
    ['v1.0.0'],
    ['1.0.0.0'],
    ['01.0.0'],
    ['1.0.x'],
    ['   '],
    ['1'],
    ['1.0.0 '],
    [' 1.0.0'],
    ['1..0'],
    ['-1.0.0'],
  ])('throws ValidationError for "%s"', (version) => {
    expect(() => assertValidSemver(version)).toThrow(ValidationError);
  });
});
