import { z } from 'zod';

/**
 * The `AgentNotificationPreferenceSet` event payload schema, per ADR-0047
 * Karar (a)/(b)/(i). `.strict()` — mass-assignment protection, matching
 * `taskAutonomyTierSetPayloadSchema`'s exact convention.
 *
 * `workspaceId`/`actor`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope, not the payload — the real setting actor
 * (`actor.id === userId`, self-only per ADR-0047 Karar i) IS the envelope's
 * own `actor`, never duplicated here. The `userId` the preference belongs to
 * is likewise NOT carried in the payload for the same reason — it is always
 * `actor.id`.
 *
 * `notificationBudgetPerWindow` bounds (0-10000) and `startHourUtc`/
 * `endHourUtc` bounds (0-23) are this schema's own pinned contract choices
 * (ADR-0047 Karar b specifies the semantics, not exact numeric bounds).
 */
export const quietHoursWindowSchema = z
  .object({
    startHourUtc: z.number().int().min(0).max(23),
    endHourUtc: z.number().int().min(0).max(23),
  })
  .strict();

export const agentNotificationPreferenceSetPayloadSchema = z
  .object({
    notificationBudgetPerWindow: z.number().int().min(0).max(10_000),
    quietHours: quietHoursWindowSchema.nullable(),
  })
  .strict();

export type QuietHoursWindowPayload = z.infer<typeof quietHoursWindowSchema>;
export type AgentNotificationPreferenceSetPayload = z.infer<
  typeof agentNotificationPreferenceSetPayloadSchema
>;
