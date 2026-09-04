import { z } from 'zod';

import { ValidationError } from '@luminaos/shared';

/**
 * A signed, versioned declaration of a single skill's callable surface —
 * per ADR-0036 Karar (b)/(c)/(d).
 */
export interface SkillManifest {
  id: string;
  version: string;
  capability: string;
  signature: string;
}

export const skillManifestSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.string().min(1).max(50),
    capability: z.string().min(1).max(500),
    signature: z.string().min(1),
  })
  .strict();

const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Throws `ValidationError` unless `version` is a strict `X.Y.Z` shape:
 * three dot-separated non-negative integer segments, each either exactly
 * "0" or a non-zero-leading digit sequence — no prerelease/build suffix,
 * no surrounding whitespace, no extra segments.
 */
export function assertValidSemver(version: string): void {
  if (!STRICT_SEMVER_PATTERN.test(version)) {
    throw new ValidationError('skill manifest version must be a strict X.Y.Z semver', {
      version,
    });
  }
}
