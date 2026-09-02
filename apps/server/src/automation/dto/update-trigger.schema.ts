import { z } from 'zod';

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

const triggerSpecSchema = z.discriminatedUnion('kind', [scheduleSpecSchema, conditionSpecSchema]);

/**
 * Validates a `PATCH /workspaces/:workspaceId/triggers/:triggerId` request
 * body — a partial update. Same shape-only-check discipline as
 * `create-trigger.schema.ts`; the domain layer's `updateTrigger`
 * (`@luminaos/automation`) re-validates business rules (including that
 * `spec.kind` is immutable once created) on every write.
 */
export const updateTriggerSchema = z
  .object({
    name: z.string().min(1).optional(),
    spec: triggerSpecSchema.optional(),
  })
  .strict();

export type UpdateTriggerInput = z.infer<typeof updateTriggerSchema>;
