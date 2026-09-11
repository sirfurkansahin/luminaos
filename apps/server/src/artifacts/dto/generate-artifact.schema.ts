import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/artifacts` request body
 * (F3-T7 PR2, ADR-0041 Karar h). `.strict()` rejects unknown body keys,
 * mirroring `parseCommandSchema`'s identical convention.
 */
export const generateArtifactSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    artifactType: z.enum(['presentation', 'dashboard', 'page', 'report']),
    themePreset: z.enum(['kurumsal', 'canli', 'minimal']),
  })
  .strict();

export type GenerateArtifactRequestInput = z.infer<typeof generateArtifactSchema>;
