import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/agents/:agentIdentifier/dm`
 * request body (F3-T3 PR5, ADR-0037 §4). `.strict()` rejects unknown keys,
 * mirroring `registerAgentSchema`'s own convention.
 */
export const sendDmMessageSchema = z
  .object({
    body: z.string().min(1).max(4000),
  })
  .strict();

export type SendDmMessageInput = z.infer<typeof sendDmMessageSchema>;
