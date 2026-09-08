import { z } from 'zod';

/**
 * The `AgentActionRecorded` event payload schema, per ADR-0038 Karar
 * (a)/(b)/(c)/(d). Mirrors `agent-permission-manifest-events.ts`'s `.strict()`
 * mass-assignment-protection convention and ADR-0035 Karar (j)'s
 * ISO-8601-string-in-jsonb convention (payloads are stored as jsonb, which
 * has no native `Date` support).
 *
 * `id`/`workspaceId`/`actor`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope (`packages/shared/src/events/domain-event.ts`),
 * not the payload — same convention as `agentPermissionGrantedPayloadSchema`.
 * The envelope's own `actor` IS `AgentActionRecord.actor` (the real approving
 * human for `'decided'`, the agent itself for `'autonomous'`), and the
 * envelope's own `occurredAt` IS the record's `occurredAt` (the record is
 * written synchronously right after the action completes) — duplicating
 * either into the payload would just be two values that must always agree,
 * with no mechanism enforcing that.
 */
export const actionResourceReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), objectId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('comment'), commentId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('meeting'), meetingId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('agent'), agentIdentifier: z.string().min(1).max(100) }).strict(),
  // `label` is free text (e.g. an AI-mentioned Slack channel name), so it
  // gets a more generous cap than the internal-id fields above, but is still
  // bounded — security-review finding, F3-T4 PR1 (unbounded AI-influenced
  // text is an event-log resource-exhaustion risk).
  z.object({ kind: z.literal('external'), label: z.string().min(1).max(200) }).strict(),
]);

export const rollbackPlanSchema = z
  .object({
    kind: z.enum(['delete', 'revertFieldValue', 'revokePermission', 'manual', 'none']),
    targetResource: actionResourceReferenceSchema.optional(),
    description: z.string().min(1).max(2000),
  })
  .strict();

export const agentActionRecordedPayloadSchema = z
  .object({
    provenance: z.enum(['decided', 'autonomous']),
    actionType: z.string().min(1).max(100),
    // `intent`/`rationale` are AI-influenced free text (the proposer's or the
    // agent's own explanation) — bounded per the same security-review
    // finding as `rollbackPlanSchema.description` above.
    intent: z.string().min(1).max(500),
    rationale: z.string().min(1).max(2000),
    resources: z.array(actionResourceReferenceSchema),
    rollbackPlan: rollbackPlanSchema,
    outcome: z.enum(['succeeded', 'partially_succeeded', 'failed', 'rejected']),
    resultRef: actionResourceReferenceSchema.nullable(),
    causationEventId: z.uuid().nullable(),
  })
  .strict();

export type ActionResourceReferencePayload = z.infer<typeof actionResourceReferenceSchema>;
export type RollbackPlanPayload = z.infer<typeof rollbackPlanSchema>;
export type AgentActionRecordedPayload = z.infer<typeof agentActionRecordedPayloadSchema>;
