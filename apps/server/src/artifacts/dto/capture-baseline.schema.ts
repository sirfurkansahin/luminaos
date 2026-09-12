import { z } from 'zod';

import { querySpecSchema } from '@luminaos/shared';

/**
 * Validates a `POST /workspaces/:workspaceId/artifacts/baselines` request
 * body (F3-T10 PR2, ADR-0044 Karar c/d). `.strict()` rejects unknown body
 * keys, mirroring `generateWidgetSchema`'s identical convention.
 * `targetFieldKey` is optional at THIS layer -- the "required for every
 * `aggregateFn` except `count`" rule (ADR-0044 Karar e) is enforced deeper,
 * by `computeQueryAggregate` (`@luminaos/artifacts`), not here.
 */
const aggregateFnSchema = z.enum([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'countUnique',
  'countEmpty',
]);

export const captureBaselineSchema = z
  .object({
    title: z.string().min(1).max(200),
    querySpec: querySpecSchema,
    aggregateFn: aggregateFnSchema,
    targetFieldKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CaptureBaselineRequestInput = z.infer<typeof captureBaselineSchema>;
