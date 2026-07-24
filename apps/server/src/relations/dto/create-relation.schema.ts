import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/relations` request body.
 *
 * `.strict()` rejects unknown keys, matching `define-field.schema.ts`'s
 * convention. `kind` is restricted to the 3 known `RelationKind` values
 * (`parentChild`/`reference`/`dependency`) here at the DTO boundary — an
 * unknown value is a 400 before it ever reaches the domain layer, same
 * "hardcode the known enum values" style as `defineFieldSchema`'s
 * `FIELD_TYPES`.
 */
export const createRelationSchema = z
  .object({
    fromId: z.string().min(1),
    toId: z.string().min(1),
    kind: z.enum(['parentChild', 'reference', 'dependency']),
  })
  .strict();

export type CreateRelationInput = z.infer<typeof createRelationSchema>;
