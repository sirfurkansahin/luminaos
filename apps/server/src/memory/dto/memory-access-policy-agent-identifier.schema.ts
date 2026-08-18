import { z } from 'zod';

/**
 * Validates `POST /workspaces/:workspaceId/memory/access-policies` request
 * bodies. Deliberately NOT `.strict()`, mirroring
 * `grant-desktop-signal-consent.schema.ts`'s exact convention: self-service
 * by construction (ADR-0024 §k) means the SESSION user (`req.user.id`) is
 * the only source of user identity — an extra `userId` key in the body is a
 * harmless, silently stripped no-op, not a validation error.
 */
export const memoryAccessPolicyAgentIdentifierSchema = z.object({
  agentIdentifier: z.string().min(1),
});

export type MemoryAccessPolicyAgentIdentifierInput = z.infer<
  typeof memoryAccessPolicyAgentIdentifierSchema
>;
