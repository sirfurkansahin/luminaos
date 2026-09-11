import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/artifacts/widgets` request body
 * (F3-T8 PR2, ADR-0042 Karar i). `.strict()` rejects unknown body keys,
 * mirroring `generateArtifactSchema`'s identical convention. Unlike
 * `generateArtifactSchema`'s `artifactType` (a fixed 4-value enum),
 * `objectType` here is a generic bounded string -- the requested Lumina
 * Object type a widget queries against isn't restricted to `artifact`
 * itself, so this DTO can't enumerate it as a closed set; the real
 * "is this a known object type" check happens deeper in the pipeline
 * (`ObjectsService.query`'s own `isKnownObjectType` guard).
 */
export const generateWidgetSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    objectType: z.string().min(1).max(100),
    themePreset: z.enum(['kurumsal', 'canli', 'minimal']),
  })
  .strict();

export type GenerateWidgetRequestInput = z.infer<typeof generateWidgetSchema>;
