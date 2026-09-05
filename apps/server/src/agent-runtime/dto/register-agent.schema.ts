import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/agents` request body
 * (F3-T3, ADR-0037 Karar b/d). `name` is constrained to the handle charset
 * `^[A-Za-z0-9_-]{2,32}$` (spec lines 22/26) so the future @mention regex
 * has no ambiguity to resolve against. The real business-rule validation
 * (uniqueness of `name`/`agentIdentifier` per workspace) is enforced by
 * `AgentDirectoryService.register`, mirroring
 * `grant-permission-manifest.schema.ts`'s own DTO-vs-domain split.
 */
export const registerAgentSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/),
    agentIdentifier: z.string().min(1).max(100),
  })
  .strict();

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;
