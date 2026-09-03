import { z } from 'zod';

/**
 * `actionTemplate` is common to both `ScheduleSpec`/`ConditionSpec` (mirrors
 * `@luminaos/automation`'s `ActionTemplate`).
 */
const actionTemplateSchema = z.object({ title: z.string().min(1) }).strict();

const scheduleSpecSchema = z
  .object({
    kind: z.literal('scheduled'),
    intervalMinutes: z.number(),
    actionTemplate: actionTemplateSchema,
  })
  .strict();

const conditionSpecSchema = z
  .object({
    kind: z.literal('condition'),
    objectType: z.string().min(1),
    fieldKey: z.string().min(1),
    pattern: z.string(),
    flags: z.string(),
    actionTemplate: actionTemplateSchema,
  })
  .strict();

export const triggerSpecSchema = z.discriminatedUnion('kind', [
  scheduleSpecSchema,
  conditionSpecSchema,
]);

/**
 * Validates a `POST /workspaces/:workspaceId/triggers` request body.
 *
 * This DTO only SHAPE-checks (numeric type, string non-empty) — the real
 * business-rule validation (positive-integer `intervalMinutes`, regex
 * safety) is enforced by the domain layer's `createTrigger`
 * (`@luminaos/automation`), the single source of truth for it (same
 * DTO-vs-domain split as `create-saved-view.schema.ts`'s own reasoning).
 */
export const createTriggerSchema = z
  .object({
    name: z.string().min(1),
    spec: triggerSpecSchema,
  })
  .strict();

export type CreateTriggerInput = z.infer<typeof createTriggerSchema>;
