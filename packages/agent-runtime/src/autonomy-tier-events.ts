import { z } from 'zod';

/**
 * The `TaskAutonomyTierSet` event payload schema, per ADR-0039 Karar (b).
 * `.strict()` — mass-assignment protection, matching
 * `agent-permission-manifest-events.ts`'s exact convention.
 *
 * `workspaceId`/`actor`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope, not the payload — the real setting actor (the
 * calling admin) IS the envelope's own `actor`, never duplicated here.
 */
export const taskAutonomyTierSetPayloadSchema = z
  .object({
    actionType: z.string().min(1).max(100),
    tier: z.enum(['propose', 'approve_and_act', 'act_and_notify']),
  })
  .strict();

export type TaskAutonomyTierSetPayload = z.infer<typeof taskAutonomyTierSetPayloadSchema>;
