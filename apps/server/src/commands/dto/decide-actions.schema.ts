import { z } from 'zod';

import { MAX_DECISIONS_PER_CALL } from '../commands.service.js';

/**
 * Validates a `POST /workspaces/:workspaceId/commands/:proposalId/decide`
 * request body. `.strict()` (both on each `decisions[]` element and the
 * outer object) rejects unknown keys, mirroring `askQuestionSchema`'s
 * identical convention. The `.max(MAX_DECISIONS_PER_CALL)` cap reuses
 * `CommandsService.decide()`'s own runtime cap constant (`../commands.service.js`)
 * so the two can never independently drift apart — either layer producing
 * the resulting 400 is correct (see `../commands.controller.integration.test.ts`'s
 * AC8 comment).
 */
export const decideActionsSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            actionId: z.string().min(1),
            decision: z.enum(['approved', 'rejected']),
          })
          .strict(),
      )
      .max(MAX_DECISIONS_PER_CALL),
  })
  .strict();

export type DecideActionsInput = z.infer<typeof decideActionsSchema>;
