import { z } from 'zod';

/**
 * The `AgentNotificationDelivered`/`AgentNotificationSuppressed` event
 * payload schemas, per ADR-0047 Karar (d). `.strict()` — mass-assignment
 * protection, mirrors `agentActionRecordedPayloadSchema`'s convention.
 *
 * `workspaceId`/`actor`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope, not the payload — same convention as every other
 * event schema in this package.
 *
 * `sourceObjectId`/`commentId` are pinned as `z.uuid()` (real object/comment
 * ids elsewhere in this codebase are uuids, e.g. `causationEventId` in
 * `agent-action-record-events.ts`); `recipientUserId`/`actionType` mirror
 * `taskAutonomyTierSetPayloadSchema`'s `actionType: z.string().min(1).max(100)`
 * bound.
 */
export const agentNotificationDeliveredPayloadSchema = z
  .object({
    recipientUserId: z.string().min(1),
    actionType: z.string().min(1).max(100),
    sourceObjectId: z.uuid(),
    // A "delivered" outcome always has a real comment (ADR-0047 Karar d) --
    // never optional/nullable, unlike `NotificationDeliveryRecord.commentId`
    // (which is `null` for the OTHER two outcomes; those use the separate
    // `agentNotificationSuppressedPayloadSchema` below, which has no
    // `commentId` field at all).
    commentId: z.uuid(),
  })
  .strict();

export const agentNotificationSuppressedPayloadSchema = z
  .object({
    recipientUserId: z.string().min(1),
    actionType: z.string().min(1).max(100),
    sourceObjectId: z.uuid(),
    reason: z.enum(['quiet_hours', 'budget_exceeded']),
  })
  .strict();

export type AgentNotificationDeliveredPayload = z.infer<
  typeof agentNotificationDeliveredPayloadSchema
>;
export type AgentNotificationSuppressedPayload = z.infer<
  typeof agentNotificationSuppressedPayloadSchema
>;
