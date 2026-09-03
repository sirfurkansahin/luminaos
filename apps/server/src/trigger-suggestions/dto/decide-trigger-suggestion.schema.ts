import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/trigger-suggestions/:suggestionId/decide`
 * request body (ADR-0034 §a/§d). `.strict()` rejects unknown keys, mirroring
 * `decideActionsSchema`'s (`../../commands/dto/decide-actions.schema.ts`)
 * identical convention.
 */
export const decideTriggerSuggestionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
  })
  .strict();

export type DecideTriggerSuggestionInput = z.infer<typeof decideTriggerSuggestionSchema>;
