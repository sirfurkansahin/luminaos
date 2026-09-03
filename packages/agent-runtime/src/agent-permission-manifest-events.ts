import { z } from 'zod';

/**
 * The two `AgentPermissionManifest` event payload schemas, per ADR-0035
 * Karar (b)/(j). Both are `.strict()` (unknown/extra keys rejected —
 * mass-assignment protection), matching `memory-access-policy-events.ts`'s
 * exact convention.
 *
 * `workspaceId`/`agentIdentifier` (granted-by) actor and `occurredAt` come
 * from the surrounding `DomainEvent` envelope, not the payload — see
 * ADR-0035 Karar (i). Dates inside the payload are ISO-8601 strings, NOT
 * `z.date()` — payloads are stored as jsonb, which has no native `Date`
 * support (ADR-0035 Karar (j)); real `Date` conversion happens only at the
 * service/projection boundary.
 */
export const agentPermissionGrantedPayloadSchema = z
  .object({
    agentIdentifier: z.string().min(1).max(100),
    dataScope: z
      .object({
        objectTypes: z.union([z.array(z.string().min(1).max(100)).max(200), z.literal('all')]),
      })
      .strict(),
    actionTypes: z.array(z.string().min(1).max(100)).min(1).max(200),
    timeWindow: z
      .object({
        startsAt: z.iso.datetime().nullable(),
        expiresAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict();

export const agentPermissionRevokedPayloadSchema = z
  .object({
    agentIdentifier: z.string().min(1),
  })
  .strict();

export type AgentPermissionGrantedPayload = z.infer<typeof agentPermissionGrantedPayloadSchema>;
export type AgentPermissionRevokedPayload = z.infer<typeof agentPermissionRevokedPayloadSchema>;
