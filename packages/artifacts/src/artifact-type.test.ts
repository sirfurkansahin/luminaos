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
  ] as const)('narrows %s correctly (%#)', (artifactType, expected) => {
    expect(describeArtifactType(artifactType)).toBe(expected);
  });
});
