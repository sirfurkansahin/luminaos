import { z } from 'zod';

import type { FieldType } from '@luminaos/core-objects';

/**
 * The 12 built-in field types, hardcoded here (not imported — `core-objects`
 * doesn't export a zod schema for `FieldType`, only the TypeScript union and
 * a `isKnownFieldType` type-guard function). `satisfies readonly FieldType[]`
 * keeps this list in sync with `core-objects`' own `FieldType` union at
 * compile time: adding/removing a variant there without updating this array
 * is a type error here.
 */
const FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'checkbox',
  'date',
  'datetime',
  'select',
  'multiSelect',
  'url',
  'email',
  'people',
  'currency',
] as const satisfies readonly FieldType[];

const fieldPermissionLevelSchema = z.enum(['view', 'edit', 'hidden']);

/**
 * Exactly the 4 workspace roles, each required — mirrors
 * `core-objects`' `isValidFieldPermissions` structural guard (no missing
 * role, no extra key, no invalid level string), enforced here at the DTO
 * boundary too so a malformed body is rejected before it reaches the domain
 * layer.
 */
export const fieldPermissionsSchema = z
  .object({
    owner: fieldPermissionLevelSchema,
    admin: fieldPermissionLevelSchema,
    member: fieldPermissionLevelSchema,
    guest: fieldPermissionLevelSchema,
  })
  .strict();

/**
 * Validates a `POST /workspaces/:workspaceId/object-types/:objectType/fields`
 * request body.
 *
 * `.strict()` rejects unknown keys, matching `create-object.schema.ts`'s
 * convention. `config`/`defaultValue` are only shape-checked as `unknown`
 * here — the real "is this config/value valid for this field type" business
 * rule is enforced by the domain layer (`defineField`'s
 * `validateFieldConfig`/`validateFieldValue`), which is the single source of
 * truth for it (same DTO-vs-domain split as `create-object.schema.ts`'s own
 * `title` reasoning).
 */
export const defineFieldSchema = z
  .object({
    key: z.string().min(1),
    label: z.string(),
    fieldType: z.enum(FIELD_TYPES),
    config: z.unknown(),
    defaultValue: z.unknown().optional(),
    permissions: fieldPermissionsSchema,
  })
  .strict();

export type DefineFieldInput = z.infer<typeof defineFieldSchema>;
