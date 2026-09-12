import { z } from 'zod';

/**
 * ADR-0045 Karar (b) — the AI-generated "sapma açıklama kartı" (deviation
 * explanation card) content shape: a short human-readable summary plus a
 * bounded list of possible causes. Mirrors `artifact-content.ts`'s
 * schema-boundary style (`.strict()`, explicit `min`/`max` bounds on every
 * string/array field).
 */
export const deviationExplanationSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    possibleCauses: z.array(z.string().min(1).max(500)).min(1).max(5),
  })
  .strict();

export type DeviationExplanationContent = z.infer<typeof deviationExplanationSchema>;
