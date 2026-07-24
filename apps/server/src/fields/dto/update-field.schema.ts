import { z } from 'zod';

import { fieldPermissionsSchema } from './define-field.schema.js';

/**
 * Validates a `PATCH
 * /workspaces/:workspaceId/object-types/:objectType/fields/:fieldDefinitionId`
 * request body — the same shape as `define-field.schema.ts`, but every field
 * optional (a partial update). `config`/`defaultValue` remain `unknown`: the
 * domain layer (`updateField`) re-validates whichever ones are actually
 * supplied against the field's own type.
 */
export const updateFieldSchema = z
  .object({
    label: z.string().optional(),
    config: z.unknown().optional(),
    defaultValue: z.unknown().optional(),
    permissions: fieldPermissionsSchema.optional(),
  })
  .strict();

export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;
