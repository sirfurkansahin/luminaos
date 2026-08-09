import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';

/**
 * The provider-facing, DB-free "turn a natural-language command into a
 * validated array of proposed actions" orchestrator: sibling of
 * `resolveAIFieldValue` (`./resolve-ai-field-value.ts`) and `answerQuestion`
 * (`./answer-question.ts`) -- provider/model/recordUsage all injected, no
 * Postgres/EventStore.
 *
 * Per ADR-0015 §e, the structured output is obtained via JSON-prompt + zod
 * validation, NOT a new `AIProvider` mode -- `AIProvider.complete()`'s
 * contract is untouched. The model is prompted to reply with a JSON ARRAY of
 * action objects directly (not wrapped in an envelope object), mirroring how
 * `resolveAIFieldValue`'s `outputType: 'select'` expects the model's entire
 * response text to BE the value.
 *
 * `actionId` is never trusted from the model: `parseCommand` mints a fresh
 * `crypto.randomUUID()` for every successfully-validated action, since a
 * model-supplied id could collide or be absent, and a future `decide` call
 * (ADR-0015 §f) needs a stable, unique handle.
 */
export interface ProposedAction {
  actionId: string;
  type: 'createTask' | 'generateSubtasks' | 'assignPeople';
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}

export interface ParseCommandInput {
  provider: AIProvider;
  command: string;
  sourceObjectId?: string;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface ParseCommandResult {
  actions: ProposedAction[];
  parseError: boolean;
  message?: string;
}

const PARSE_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into valid proposed actions after retry';

export const proposedActionSchema = z
  .object({
    type: z.enum(['createTask', 'generateSubtasks', 'assignPeople']),
    intent: z.string().min(1),
    rationale: z.string().min(1),
    resources: z.array(z.string()),
    rollbackNote: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
  })
  .array();

function renderCommandPrompt(command: string, sourceObjectId?: string): string {
  return [
    'Parse the natural-language command below into a JSON array of proposed actions.',
    'Respond with ONLY a JSON array (no surrounding text, no markdown fences), where each element has exactly these fields:',
    '- type: one of "createTask", "generateSubtasks", "assignPeople"',
    '- intent: a short string describing what this action is meant to accomplish',
    '- rationale: a short string explaining why this action is proposed',
    '- resources: an array of strings naming the objects/resources this action touches',
    '- rollbackNote: a short string describing how to undo this action',
    '- params: an object with any additional parameters this action needs',
    '',
    `Command: ${command}`,
    ...(sourceObjectId !== undefined ? [`Source object id: ${sourceObjectId}`] : []),
  ].join('\n');
}

function tryParseActions(text: string): ProposedAction[] | undefined {
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

  return result.data.map((action) => ({
    ...action,
    actionId: randomUUID(),
  }));
}

export async function parseCommand(input: ParseCommandInput): Promise<ParseCommandResult> {
  const prompt = renderCommandPrompt(input.command, input.sourceObjectId);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstActions = tryParseActions(firstResponse);

  if (firstActions !== undefined) {
    return { actions: firstActions, parseError: false };
  }

  const retryResponse = await complete();
  const retryActions = tryParseActions(retryResponse);

  if (retryActions !== undefined) {
    return { actions: retryActions, parseError: false };
  }

  return { actions: [], parseError: true, message: PARSE_EXHAUSTED_MESSAGE };
}
