import { z } from 'zod';

/**
 * DoS-cap-via-validation-REJECTION convention (mirrors
 * `../../qa/dto/ask-question.schema.ts`'s `MAX_QUESTION_LENGTH`): a
 * conversation COMMAND can reference multiple subtasks/assignees in one
 * sentence, so this cap is deliberately larger than a single
 * natural-language question's own `MAX_QUESTION_LENGTH` (500).
 */
export const MAX_COMMAND_LENGTH = 2000;

/**
 * A ULID is 26 characters; generously bounded well above that so a
 * malformed/oversized id string can't slip through as a `.max()`-less value
 * (mirrors `../../objects/dto/reorder-checklist.schema.ts`'s
 * `MAX_ITEM_ID_LENGTH` convention). Without this cap, an oversized
 * `sourceObjectId` would pass validation, inflate the AI prompt sent to
 * `parseCommand`, and then fail at the `command_proposals.source_object_id`
 * (`varchar(26)`) write — AFTER the immutable `ActionsProposed` event has
 * already been durably appended, orphaning the proposal (security review,
 * F1-T16 PR6).
 */
const MAX_SOURCE_OBJECT_ID_LENGTH = 100;

/**
 * Validates a `POST /workspaces/:workspaceId/commands/parse` request body.
 * `.strict()` rejects unknown body keys, mirroring `askQuestionSchema`'s
 * identical convention.
 */
export const parseCommandSchema = z
  .object({
    command: z.string().min(1).max(MAX_COMMAND_LENGTH),
    sourceObjectId: z.string().min(1).max(MAX_SOURCE_OBJECT_ID_LENGTH).optional(),
  })
  .strict();

export type ParseCommandInput = z.infer<typeof parseCommandSchema>;
