import { z } from 'zod';

/**
 * Validates a `PATCH /workspaces/:workspaceId/objects/:objectId/fields`
 * request body. `values` is a flat `{ [fieldKey]: value }` map — key names
 * are arbitrary workspace-defined field keys (not enumerable here), and
 * `value` is `z.unknown()` because real per-field-type validation is the
 * domain layer's job (`setFieldValue`/`validateFieldValue`,
 * `@luminaos/core-objects`), not this DTO boundary's.
 */
export const setFieldValuesSchema = z
  .object({
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

export type SetFieldValuesInput = z.infer<typeof setFieldValuesSchema>;
