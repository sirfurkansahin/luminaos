import { z } from 'zod';

import type { ViewType } from '@luminaos/core-objects';
import { querySpecSchema } from '@luminaos/shared';

/**
 * The 5 known `ViewType` values, hardcoded here (not imported —
 * `core-objects` doesn't export a zod schema for `ViewType`, only the
 * TypeScript union), matching `define-field.schema.ts`'s `FIELD_TYPES`
 * convention. `satisfies readonly ViewType[]` keeps this list in sync with
 * `core-objects`' own `ViewType` union at compile time.
 */
const VIEW_TYPES = [
  'list',
  'board',
  'table',
  'calendar',
  'timeline',
] as const satisfies readonly ViewType[];

/**
 * A saved view's `querySpec` never carries `cursor`/`limit` — those are
 * per-request pagination fields, meaningless in a persisted record (F1-T9
 * plan).
 */
const savedQuerySpecSchema = querySpecSchema.omit({ cursor: true, limit: true });

/**
 * Validates a `POST /workspaces/:workspaceId/views` request body.
 *
 * `.strict()` rejects unknown keys — in particular, there is NO `ownerId`
 * field here at all: the server always derives `ownerId` itself from the
 * caller's session (`shared: true` -> `null`, `shared: false` -> the
 * caller's own id), never trusting a client-supplied value (F1-T9 plan).
 * `dateField`/`startField`/`endField` are only shape-checked here as
 * optional strings — the real viewType<->field-selection consistency rule
 * (e.g. `calendar` requires exactly `dateField`) is enforced by the domain
 * layer's `createSavedView`, the single source of truth for it (same
 * DTO-vs-domain split as `define-field.schema.ts`'s own reasoning).
 */
export const createSavedViewSchema = z
  .object({
    name: z.string().min(1),
    icon: z.string().min(1),
    viewType: z.enum(VIEW_TYPES),
    objectType: z.string().min(1),
    querySpec: savedQuerySpecSchema,
    dateField: z.string().min(1).optional(),
    startField: z.string().min(1).optional(),
    endField: z.string().min(1).optional(),
    shared: z.boolean(),
  })
  .strict();

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
