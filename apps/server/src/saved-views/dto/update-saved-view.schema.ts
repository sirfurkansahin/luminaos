import { z } from 'zod';

import { querySpecSchema } from '@luminaos/shared';

const savedQuerySpecSchema = querySpecSchema.omit({ cursor: true, limit: true });

/**
 * Validates a `PATCH /workspaces/:workspaceId/views/:savedViewId` request
 * body — a partial update. `objectType`/`shared`/`ownerId`/`viewType` are
 * intentionally NOT patchable here: `objectType`/`shared`/`ownerId` would
 * change what a saved view fundamentally IS (and `ownerId` must never be
 * client-controlled at all, same reasoning as `create-saved-view.schema.ts`).
 * `viewType` is also not patchable — F1-T9's scope only supports renaming/
 * re-iconing/re-querying an existing view, not converting its type. `name`
 * IS patchable (renaming is exactly what this endpoint is for).
 */
export const updateSavedViewSchema = z
  .object({
    name: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    querySpec: savedQuerySpecSchema.optional(),
    dateField: z.string().min(1).optional(),
    startField: z.string().min(1).optional(),
    endField: z.string().min(1).optional(),
  })
  .strict();

export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
