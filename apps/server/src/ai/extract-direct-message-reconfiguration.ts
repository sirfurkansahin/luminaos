import { randomUUID } from 'node:crypto';

import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';

import { proposedActionSchema } from './parse-command.js';

import type { ProposedAction } from './parse-command.js';

/**
 * The provider-facing, DB-free "extract exactly ONE
 * reconfigureAgentPermissions-typed proposed action from a DM message"
 * orchestrator: sibling of `parseCommand` (`./parse-command.ts`) and
 * `extractMeetingActions` (`./extract-meeting-actions.ts`), per ADR-0037 §4.
 * Mirrors `extractMeetingActions`'s structure (JSON-prompt + `JSON.parse` +
 * zod-validate + one identical-prompt retry + `{actions:[], parseError:true,
 * message}` double-failure sentinel, `actionId` minted via
 * `crypto.randomUUID()` for the successfully-validated action) almost
 * verbatim.
 *
 * The only functional differences from `extractMeetingActions`: (1) its own
 * prompt template, requesting exactly ONE action of type
 * `reconfigureAgentPermissions`, and (2) TWO independent post-schema
 * validation checks layered on top of `proposedActionSchema.safeParse`
 * alone: since the shared schema was widened to accept SIX types (ADR-0037
 * §4), a schema-valid-but-wrong-type response (e.g. the model echoing
 * `createTask`) must be treated as a validation failure, AND (unlike
 * `extractMeetingActions`, which allows any positive count) the response
 * must contain EXACTLY ONE action -- a DM proposes exactly one
 * reconfiguration, never zero, never multiple. Either violation triggers the
 * same retry-once-then-fallback path as malformed/schema-invalid JSON.
 */
export type { ProposedAction };

export interface ExtractDirectMessageReconfigurationInput {
  provider: AIProvider;
  dmMessageText: string;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface ExtractDirectMessageReconfigurationResult {
  actions: ProposedAction[];
  parseError: boolean;
  message?: string;
}

const EXTRACT_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into a valid reconfigureAgentPermissions action after retry';

function renderDirectMessageReconfigurationPrompt(dmMessageText: string): string {
  return [
    'Extract the agent-permission reconfiguration requested in the direct message below into a JSON array containing EXACTLY ONE proposed action.',
    'Respond with ONLY a JSON array of exactly one element (no surrounding text, no markdown fences), where that element has exactly these fields:',
    '- type: must always be "reconfigureAgentPermissions"',
    '- intent: a short string describing what this action is meant to accomplish',
    '- rationale: a short string explaining why this action is proposed',
    '- resources: an array of strings naming the objects/resources this action touches',
    '- rollbackNote: a short string describing how to undo this action',
    '- params: an object with fields { agentIdentifier, operation: "grant" | "revoke", dataScope?, actionTypes?, timeWindow? } describing the reconfiguration',
    '',
    `DM message: ${dmMessageText}`,
  ].join('\n');
}

function tryParseDirectMessageReconfiguration(text: string): ProposedAction[] | undefined {
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

  if (result.data.length !== 1) {
    return undefined;
  }

  const allReconfigureAgentPermissions = result.data.every(
    (action) => action.type === 'reconfigureAgentPermissions',
  );

  if (!allReconfigureAgentPermissions) {
    return undefined;
  }

  return result.data.map((action) => ({
    ...action,
    actionId: randomUUID(),
  }));
}

export async function extractDirectMessageReconfiguration(
  input: ExtractDirectMessageReconfigurationInput,
): Promise<ExtractDirectMessageReconfigurationResult> {
  const prompt = renderDirectMessageReconfigurationPrompt(input.dmMessageText);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstActions = tryParseDirectMessageReconfiguration(firstResponse);

  if (firstActions !== undefined) {
    return { actions: firstActions, parseError: false };
  }

  const retryResponse = await complete();
  const retryActions = tryParseDirectMessageReconfiguration(retryResponse);

  if (retryActions !== undefined) {
    return { actions: retryActions, parseError: false };
  }

  return { actions: [], parseError: true, message: EXTRACT_EXHAUSTED_MESSAGE };
}
