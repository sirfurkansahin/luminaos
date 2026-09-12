import { describe, expect, it } from 'vitest';

import type { ArtifactType } from './artifact-type.js';

/**
 * F3-T7 PR1 (RED step), ADR-0041 Karar (f) — `packages/artifacts/src/artifact-type.ts`.
 *
 *   export type ArtifactType = 'presentation' | 'dashboard' | 'page' | 'report';
 *
 * `ArtifactType` is a plain union type with zero runtime behavior -- there is
 * nothing to unit-test about its shape beyond a compile-time exhaustiveness
 * canary (mirrors `packages/agent-runtime/src/autonomy-tier.test.ts`'s
 * `describeTier` pattern for the same category of type).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/artifact-type.ts` — this module does not exist yet
 * at all, so this import fails with "Cannot find module".
 *
 * F3-T10 PR1 (RED step), ADR-0044 Karar (a)/(e)/(f) — `ArtifactType` gains a
 * 5th value, `'baseline'`. The `case 'baseline'` branch below and its
 * `it.each` row are added AHEAD of `implementer` widening the real
 * `ArtifactType` union in `artifact-type.ts` — until then, `artifactType:
 * ArtifactType` narrows to only the original 4 values, so `case 'baseline'`
 * compares a literal that has no overlap with the parameter's type (TS2678)
 * and the `it.each` row's `'baseline'` argument is not assignable to
 * `ArtifactType` — both are expected `tsc --noEmit` compile errors (this
 * file's own exhaustiveness check doing its job), even though vitest's
 * esbuild transform does not type-check and so `pnpm test` alone may still
 * report this file as passing at the runtime level.
 */

function describeArtifactType(artifactType: ArtifactType): string {
  switch (artifactType) {
    case 'presentation':
      return 'presentation';
    case 'dashboard':
      return 'dashboard';
    case 'page':
      return 'page';
    case 'report':
      return 'report';
    case 'baseline':
      return 'baseline';
    default: {
      const exhaustiveCheck: never = artifactType;
      throw new Error(`Unhandled ArtifactType: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

describe('ArtifactType -- discriminated-union narrowing (exhaustiveness canary)', () => {
  it.each([
    ['presentation', 'presentation'],
    ['dashboard', 'dashboard'],
    ['page', 'page'],
    ['report', 'report'],
    ['baseline', 'baseline'],
  ] as const)('narrows %s correctly (%#)', (artifactType, expected) => {
    expect(describeArtifactType(artifactType)).toBe(expected);
  });
});
