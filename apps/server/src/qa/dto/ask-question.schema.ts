import { z } from 'zod';

/**
 * DoS-cap-via-validation-REJECTION convention (mirrors
 * `../../search/dto/search-workspace.schema.ts`'s `MAX_QUERY_LENGTH`): a
 * natural-language QUESTION is typically a full sentence (or several),
 * structurally longer than a keyword search box query, so this cap is
 * deliberately larger than search's own `MAX_QUERY_LENGTH` (200).
 */
export const MAX_QUESTION_LENGTH = 500;

/**
 * Validates a `POST /workspaces/:workspaceId/qa` request body. `.strict()`
 * rejects unknown body keys, mirroring `searchWorkspaceSchema`'s identical
 * convention.
 */
export const askQuestionSchema = z
  .object({
    question: z.string().min(1).max(MAX_QUESTION_LENGTH),
  })
  .strict();

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;
