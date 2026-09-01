import { randomUUID } from 'node:crypto';

import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';

import { proposedActionSchema } from './parse-command.js';

import type { ProposedAction } from './parse-command.js';

/**
 * The provider-facing, DB-free "extract createTaskFromMeeting-typed proposed
 * actions from a meeting transcript" orchestrator: sibling of `parseCommand`
 * (`./parse-command.ts`), per ADR-0031 §e. Mirrors `parseCommand`'s
 * structure (JSON-prompt + `JSON.parse` + zod-validate + one identical-prompt
 * retry + `{actions:[], parseError:true, message}` double-failure sentinel,
 * `actionId` minted via `crypto.randomUUID()` for every successfully-
 * validated action) almost verbatim.
 *
 * The only functional differences from `parseCommand`: (1) its own prompt
 * template, requesting exactly ONE action type
 * (`createTaskFromMeeting`) instead of three, and (2) an EXTRA
 * type-strictness check beyond `proposedActionSchema.safeParse` alone: since
 * the shared schema was widened to accept FOUR types (ADR-0031 §e), a
 * schema-valid-but-wrong-type response (e.g. the model echoing `createTask`)
 * must be treated as a validation failure and trigger the same
 * retry-once-then-fallback path as malformed/schema-invalid JSON.
 */
export type { ProposedAction };

export interface ExtractMeetingActionsInput {
  provider: AIProvider;
  transcriptText: string;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface ExtractMeetingActionsResult {
  actions: ProposedAction[];
  parseError: boolean;
  message?: string;
}

const EXTRACT_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into valid createTaskFromMeeting actions after retry';

function renderMeetingActionsPrompt(transcriptText: string): string {
  return [
    'Extract action items from the meeting transcript below into a JSON array of proposed actions.',
    'Respond with ONLY a JSON array (no surrounding text, no markdown fences), where each element has exactly these fields:',
    '- type: must always be "createTaskFromMeeting"',
    '- intent: a short string describing what this action is meant to accomplish',
    '- rationale: a short string explaining why this action is proposed',
    '- resources: an array of strings naming the objects/resources this action touches',
    '- rollbackNote: a short string describing how to undo this action',
    '- params: an object with fields { title, assigneeHint?, dueDateHint? } describing the task to create',
    '',
    `Transcript: ${transcriptText}`,
  ].join('\n');
}

function tryParseMeetingActions(text: string): ProposedAction[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const result = proposedActionSchema.safeParse(parsed);

  if (!result.success) {
    return undefined;
  }

  const allCreateTaskFromMeeting = result.data.every(
    (action) => action.type === 'createTaskFromMeeting',
  );

  if (!allCreateTaskFromMeeting) {
    return undefined;
  }

  return result.data.map((action) => ({
    ...action,
    actionId: randomUUID(),
  }));
}

export async function extractMeetingActions(
  input: ExtractMeetingActionsInput,
): Promise<ExtractMeetingActionsResult> {
  const prompt = renderMeetingActionsPrompt(input.transcriptText);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstActions = tryParseMeetingActions(firstResponse);

  if (firstActions !== undefined) {
    return { actions: firstActions, parseError: false };
  }

  const retryResponse = await complete();
  const retryActions = tryParseMeetingActions(retryResponse);

  if (retryActions !== undefined) {
    return { actions: retryActions, parseError: false };
  }

  return { actions: [], parseError: true, message: EXTRACT_EXHAUSTED_MESSAGE };
}
